import uuid
import os
import asyncio
import json
import re
import threading
from urllib.parse import quote
from fastapi import APIRouter, HTTPException, BackgroundTasks, UploadFile, File, Form
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from pydantic import BaseModel, field_validator
from enum import Enum
from ..services.ytdlp_service import (
    JOB_STORE, fetch_info, cleanup_job, CancelledException, CookieContext,
    opts_best, opts_audio, opts_resolution, opts_keypad,
    download_thumbnail_to_job, extract_video_id
)
from ..services.cookie_service import (
    store_cookies, get_cookies, delete_cookies, validate_cookie_format
)
import yt_dlp

router = APIRouter(prefix="/api", tags=["download"])

YOUTUBE_PATTERN = re.compile(
    r'^(https?://)?'
    r'(www\.|m\.|music\.)?'
    r'(youtube\.com/(watch|embed|shorts|v)|youtu\.be/)'
    r'.+',
    re.IGNORECASE
)


class Mode(str, Enum):
    BEST = "best"
    AUDIO = "audio"
    RESOLUTION = "resolution"
    KEYPAD = "keypad"


class DownloadReq(BaseModel):
    url: str
    mode: Mode = Mode.BEST
    resolution: int | None = None
    use_cookies: bool = False  # ✅ If true, requires a prior cookie upload tied to a session

    @field_validator('url')
    @classmethod
    def validate_url(cls, v):
        if not v or not isinstance(v, str):
            raise ValueError('URL is required')
        v = v.strip()
        if not YOUTUBE_PATTERN.match(v):
            raise ValueError('Please enter a valid YouTube URL (youtube.com/watch?v=... or youtu.be/...)')
        if not v.startswith('http'):
            v = 'https://' + v
        return v


class InfoReq(BaseModel):
    url: str
    cookie_session: str | None = None  # ✅ Session ID that has cookies stored

    @field_validator('url')
    @classmethod
    def validate_url(cls, v):
        if not v or not isinstance(v, str):
            raise ValueError('URL is required')
        v = v.strip()
        if not YOUTUBE_PATTERN.match(v):
            raise ValueError('Please enter a valid YouTube URL')
        if not v.startswith('http'):
            v = 'https://' + v
        return v


class ThumbnailReq(BaseModel):
    url: str
    thumbnail_url: str
    original_quality: bool = True

    @field_validator('url', 'thumbnail_url')
    @classmethod
    def validate_urls(cls, v):
        if not v or not isinstance(v, str):
            raise ValueError('URL is required')
        return v.strip()


# ──────────────────────────────────────────────
# COOKIE UPLOAD ENDPOINT
# ──────────────────────────────────────────────
@router.post("/cookies/upload")
async def upload_cookies(file: UploadFile = File(...)):
    """
    Upload a Netscape-format cookies.txt file.
    Returns a short-lived session ID. Cookies live in RAM only, never on disk.
    """
    if not file.filename:
        raise HTTPException(400, "No file provided")

    # Read content (cap at 1MB to prevent abuse)
    content = await file.read(1_000_000)
    if not content:
        raise HTTPException(400, "Empty file")

    try:
        cookies_text = content.decode("utf-8")
    except UnicodeDecodeError:
        try:
            cookies_text = content.decode("latin-1")
        except Exception:
            raise HTTPException(400, "Could not read file as text")

    # Validate it looks like a real cookies file
    is_valid, msg = validate_cookie_format(cookies_text)
    if not is_valid:
        raise HTTPException(400, msg)

    # Store under a random session ID (NOT the job id — cookies are uploaded before analysis)
    session_id = f"sess-{str(uuid.uuid4())[:8]}"
    store_cookies(session_id, cookies_text)

    return {
        "success": True,
        "cookie_session": session_id,
        "message": "Cookies loaded into memory. They will be used for your next request and then discarded.",
    }


@router.post("/cookies/clear/{session_id}")
async def clear_cookies(session_id: str):
    """Manually discard uploaded cookies before using them."""
    delete_cookies(session_id)
    return {"success": True, "message": "Cookies removed from memory"}


# ──────────────────────────────────────────────
# VIDEO INFO
# ──────────────────────────────────────────────
@router.post("/video/info")
async def video_info(req: InfoReq):
    # Pull cookies from session if provided
    cookies_text = get_cookies(req.cookie_session) if req.cookie_session else None

    info, err = fetch_info(req.url, cookies_text=cookies_text)

    # ✅ Purge cookies immediately after use (one-time use policy)
    if req.cookie_session:
        delete_cookies(req.cookie_session)

    if not info:
        detail = (err or "Unknown error").lower()
        if "sign in to confirm" in detail or "not a bot" in detail or "cookies" in detail:
            raise HTTPException(
                400,
                "YouTube is blocking this request (anti-bot protection). "
                "Enable 'Use my cookies' and upload your YouTube cookies to authenticate, "
                "or try a different public video."
            )
        if "private" in detail:
            raise HTTPException(400, "This video is private and cannot be accessed.")
        if "age" in detail and "restrict" in detail:
            raise HTTPException(400, "This video is age-restricted and requires sign-in (use cookies).")
        if "not available" in detail or "removed" in detail:
            raise HTTPException(400, "This video is unavailable or has been removed.")
        if "429" in detail or "too many" in detail:
            raise HTTPException(400, "YouTube rate-limited us. Wait a minute and retry.")
        raise HTTPException(400, f"Could not fetch video info: {err or 'Unknown error'}")

    formats = info.get("formats", [])
    resolutions = sorted(
        list(set(f.get("height") for f in formats if f.get("height") and f.get("vcodec") != "none")),
        reverse=True
    )
    thumbnails = info.get("thumbnails", [])
    thumb_urls = [t["url"] for t in thumbnails if t.get("url")]

    channel_id = info.get("channel_id") or info.get("uploader_id")
    channel_url = info.get("channel_url") or info.get("uploader_url")
    uploader_thumbs = info.get("uploader_thumbnails", []) or info.get("channel_thumbnails", [])
    channel_logo = uploader_thumbs[-1]["url"] if uploader_thumbs else None
    if not channel_logo and channel_id:
        channel_logo = f"https://yt3.googleusercontent.com/{channel_id}"

    video_id = extract_video_id(req.url)
    original_thumb_url = (
        f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg" if video_id else info.get("thumbnail")
    )

    return {
        "success": True,
        "title": info.get("title"),
        "description": info.get("description", ""),
        "tags": info.get("tags", []),
        "categories": info.get("categories", []),
        "duration": info.get("duration"),
        "view_count": info.get("view_count"),
        "like_count": info.get("like_count"),
        "upload_date": info.get("upload_date"),
        "thumbnail": info.get("thumbnail"),
        "original_thumbnail": original_thumb_url,
        "thumbnails": thumb_urls,
        "uploader": info.get("uploader") or info.get("channel"),
        "channel_id": channel_id,
        "channel_url": channel_url,
        "channel_logo": channel_logo,
        "channel_banner": info.get("channel_banner"),
        "channel_tags": info.get("channel_tags", []),
        "subscriber_count": info.get("channel_follower_count"),
        "available_resolutions": resolutions,
        "has_audio": any(f.get("acodec") != "none" for f in formats),
        "used_cookies": cookies_text is not None,
    }


# ──────────────────────────────────────────────
# DOWNLOAD
# ──────────────────────────────────────────────
@router.post("/download")
async def start_download(
    url: str = Form(...),
    mode: Mode = Form(Mode.BEST),
    resolution: int | None = Form(None),
    cookie_session: str | None = Form(None),
    bg: BackgroundTasks = None,
):
    """
    Multipart form endpoint so we can accept an optional cookie file upload
    in the same request as the download parameters.
    """
    # Validate URL
    url = url.strip()
    if not YOUTUBE_PATTERN.match(url):
        raise HTTPException(400, "Invalid YouTube URL")
    if not url.startswith('http'):
        url = 'https://' + url

    job_id = str(uuid.uuid4())[:8]
    job_dir = f"/tmp/yt-dl/{job_id}"
    os.makedirs(job_dir, exist_ok=True)

    # Resolve cookies from session if provided
    cookies_text = get_cookies(cookie_session) if cookie_session else None

    JOB_STORE[job_id] = {
        "status": "queued",
        "progress": {},
        "output_dir": job_dir,
        "cancel_event": threading.Event(),
        "_cookies_text": cookies_text,  # Stash for the background task
    }

    # Purge from session store (job now owns them)
    if cookie_session:
        delete_cookies(cookie_session)

    bg.add_task(run_download, job_id, url, mode, resolution, job_dir)
    return {"job_id": job_id}


def run_download(job_id, url, mode, resolution, job_dir):
    cookies_text = JOB_STORE[job_id].pop("_cookies_text", None)
    try:
        if mode == Mode.AUDIO:
            opts = opts_audio(job_dir, 3, job_id)
        elif mode == Mode.RESOLUTION and resolution:
            opts = opts_resolution(job_dir, str(resolution), 3, job_id)
        elif mode == Mode.KEYPAD:
            opts = opts_keypad(job_dir, 3, job_id)
        else:
            opts = opts_best(job_dir, 3, job_id)

        # ✅ Use cookies via secure temp-file context (wiped after download)
        with CookieContext(cookies_text) as cookie_file:
            if cookie_file:
                opts["cookiefile"] = cookie_file
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])

        if JOB_STORE[job_id]["cancel_event"].is_set():
            raise CancelledException("Cancelled during processing")

        files = os.listdir(job_dir)
        JOB_STORE[job_id].update({
            "status": "completed",
            "filename": files[0] if files else None
        })

    except CancelledException:
        JOB_STORE[job_id].update({"status": "cancelled", "error": "Download cancelled by user"})
        cleanup_job(job_id)
    except Exception as e:
        JOB_STORE[job_id].update({"status": "failed", "error": str(e)})
        cleanup_job(job_id)


@router.post("/download/{job_id}/cancel")
async def cancel_download(job_id: str):
    job = JOB_STORE.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] in ["completed", "failed", "cancelled"]:
        raise HTTPException(400, f"Job already {job['status']}")
    job["cancel_event"].set()
    JOB_STORE[job_id]["status"] = "cancelling"
    return {"success": True, "message": "Cancellation requested"}


@router.post("/download/thumbnail")
async def download_thumbnail(req: ThumbnailReq, bg: BackgroundTasks):
    job_id = f"thumb-{str(uuid.uuid4())[:6]}"
    job_dir = f"/tmp/yt-dl/{job_id}"
    os.makedirs(job_dir, exist_ok=True)
    JOB_STORE[job_id] = {
        "status": "downloading",
        "progress": {"percent": "—", "percent_num": 0, "message": "Fetching original quality..."},
        "output_dir": job_dir,
        "cancel_event": threading.Event(),
    }
    bg.add_task(run_thumbnail_download, job_id, req.thumbnail_url, job_dir, req.original_quality, req.url)
    return {"job_id": job_id}


def run_thumbnail_download(job_id, thumb_url, job_dir, original_quality, video_url):
    try:
        result = download_thumbnail_to_job(
            url=thumb_url, job_dir=job_dir,
            force_original=original_quality, video_url=video_url,
        )
        if result:
            filepath = os.path.join(job_dir, result)
            size_kb = os.path.getsize(filepath) / 1024
            JOB_STORE[job_id].update({
                "status": "completed", "filename": result,
                "progress": {"percent": "100%", "percent_num": 100, "message": f"Saved {size_kb:.0f} KB • {result}"},
            })
        else:
            JOB_STORE[job_id].update({"status": "failed", "error": "All quality attempts failed"})
    except Exception as e:
        JOB_STORE[job_id].update({"status": "failed", "error": str(e)})
        cleanup_job(job_id)


@router.get("/download/{job_id}/progress")
async def progress(job_id: str):
    async def gen():
        while True:
            if job_id not in JOB_STORE:
                break
            safe_job = {k: v for k, v in JOB_STORE[job_id].items() if not k.startswith("_") and k != "cancel_event"}
            yield f"data: {json.dumps(safe_job)}\n\n"
            if JOB_STORE[job_id]["status"] in ["completed", "failed", "cancelled"]:
                break
            await asyncio.sleep(0.5)
    return StreamingResponse(gen(), media_type="text/event-stream")


@router.get("/download/{job_id}/file")
async def get_file(job_id: str):
    job = JOB_STORE.get(job_id)
    if not job or job["status"] != "completed":
        raise HTTPException(404, "File not ready")
    filepath = os.path.join(job["output_dir"], job["filename"])
    if not os.path.exists(filepath):
        raise HTTPException(404, "File missing")

    ext = os.path.splitext(job["filename"])[1].lower()
    mime_map = {
        ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".3gp": "video/3gpp",
        ".webm": "video/webm", ".m4a": "audio/mp4",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    }
    media_type = mime_map.get(ext, "application/octet-stream")
    ascii_filename = job["filename"].encode("ascii", "ignore").decode()
    utf8_filename = quote(job["filename"])

    return FileResponse(
        path=filepath, filename=ascii_filename, media_type=media_type,
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_filename}\"; filename*=UTF-8''{utf8_filename}",
            "Cache-Control": "no-store",
        }
    )