import uuid
import os
import asyncio
import json
import re
import threading
from urllib.parse import quote
from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from pydantic import BaseModel, field_validator
from enum import Enum
from ..services.ytdlp_service import (
    JOB_STORE, fetch_info, cleanup_job, CancelledException,
    opts_best, opts_audio, opts_resolution, opts_keypad,
    download_thumbnail_to_job, extract_video_id
)
import yt_dlp

router = APIRouter(prefix="/api", tags=["download"])

# Lenient YouTube URL pattern — clearer errors than Pydantic's strict HttpUrl
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


@router.post("/video/info")
async def video_info(req: DownloadReq):
    info, err = fetch_info(req.url)

    if not info:
        # Surface the REAL yt-dlp error so we can diagnose cloud blocking
        detail = err or "Unknown error"
        raise HTTPException(
            400,
            f"Could not fetch video info: {detail}"
        )

    formats = info.get("formats", [])
    resolutions = sorted(
        list(set(
            f.get("height") for f in formats
            if f.get("height") and f.get("vcodec") != "none"
        )),
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
        f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg"
        if video_id else info.get("thumbnail")
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
    }


@router.post("/download")
async def start_download(req: DownloadReq, bg: BackgroundTasks):
    job_id = str(uuid.uuid4())[:8]
    job_dir = f"/tmp/yt-dl/{job_id}"
    os.makedirs(job_dir, exist_ok=True)

    JOB_STORE[job_id] = {
        "status": "queued",
        "progress": {},
        "output_dir": job_dir,
        "cancel_event": threading.Event(),
    }

    bg.add_task(run_download, job_id, req, job_dir)
    return {"job_id": job_id}


def run_download(job_id, req, job_dir):
    try:
        if req.mode == Mode.AUDIO:
            opts = opts_audio(job_dir, 3, job_id)
        elif req.mode == Mode.RESOLUTION and req.resolution:
            opts = opts_resolution(job_dir, str(req.resolution), 3, job_id)
        elif req.mode == Mode.KEYPAD:
            opts = opts_keypad(job_dir, 3, job_id)
        else:
            opts = opts_best(job_dir, 3, job_id)

        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([req.url])

        if JOB_STORE[job_id]["cancel_event"].is_set():
            raise CancelledException("Cancelled during processing")

        files = os.listdir(job_dir)
        JOB_STORE[job_id].update({
            "status": "completed",
            "filename": files[0] if files else None
        })

    except CancelledException:
        JOB_STORE[job_id].update({
            "status": "cancelled",
            "error": "Download cancelled by user"
        })
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

    bg.add_task(
        run_thumbnail_download,
        job_id,
        req.thumbnail_url,
        job_dir,
        req.original_quality,
        req.url,
    )
    return {"job_id": job_id}


def run_thumbnail_download(job_id, thumb_url, job_dir, original_quality, video_url):
    try:
        result = download_thumbnail_to_job(
            url=thumb_url,
            job_dir=job_dir,
            force_original=original_quality,
            video_url=video_url,
        )
        if result:
            filepath = os.path.join(job_dir, result)
            size_kb = os.path.getsize(filepath) / 1024
            JOB_STORE[job_id].update({
                "status": "completed",
                "filename": result,
                "progress": {
                    "percent": "100%",
                    "percent_num": 100,
                    "message": f"Saved {size_kb:.0f} KB • {result}",
                }
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
            safe_job = {k: v for k, v in JOB_STORE[job_id].items() if k != "cancel_event"}
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
        ".mp4": "video/mp4",
        ".mp3": "audio/mpeg",
        ".3gp": "video/3gpp",
        ".webm": "video/webm",
        ".m4a": "audio/mp4",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }
    media_type = mime_map.get(ext, "application/octet-stream")

    ascii_filename = job["filename"].encode("ascii", "ignore").decode()
    utf8_filename = quote(job["filename"])

    return FileResponse(
        path=filepath,
        filename=ascii_filename,
        media_type=media_type,
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_filename}\"; filename*=UTF-8''{utf8_filename}",
            "Cache-Control": "no-store",
        }
    )