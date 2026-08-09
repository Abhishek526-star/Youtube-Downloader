import os
import re
import shutil
import logging
import threading
from typing import Dict, Any, Optional
from urllib.parse import urlparse, parse_qs

import requests
import yt_dlp

logger = logging.getLogger(__name__)

# In-memory job store
JOB_STORE: Dict[str, Dict[str, Any]] = {}

# Strip terminal color codes that leak into yt-dlp strings
ANSI_ESCAPE = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE.sub('', text).strip() if text else text


def extract_video_id(url: str) -> Optional[str]:
    """Extract YouTube video ID from various URL formats."""
    try:
        parsed = urlparse(url)
        if "v" in parse_qs(parsed.query):
            return parse_qs(parsed.query)["v"][0]
        if parsed.hostname in ("youtu.be", "www.youtu.be"):
            return parsed.path.lstrip("/").split("/")[0]
        parts = parsed.path.strip("/").split("/")
        if parts[0] in ("embed", "shorts", "v") and len(parts) > 1:
            return parts[1]
    except Exception:
        pass
    return None


# YouTube serves thumbnails at these predictable paths (highest → lowest quality)
THUMB_QUALITY_PATHS = [
    "maxresdefault.jpg",   # 1280×720 — TRUE ORIGINAL for HD videos
    "sddefault.jpg",       # 640×480
    "hqdefault.jpg",       # 480×360
    "mqdefault.jpg",       # 320×180
    "default.jpg",         # 120×90
]


class CancelledException(Exception):
    """Raised inside progress hook to abort yt-dlp download."""
    pass


def create_progress_hook(job_id: str):
    def hook(d):
        if job_id not in JOB_STORE:
            return

        cancel_event = JOB_STORE[job_id].get("cancel_event")
        if cancel_event and cancel_event.is_set():
            raise CancelledException(f"Job {job_id} cancelled by user")

        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            percent = round((downloaded / total * 100), 1) if total > 0 else 0

            JOB_STORE[job_id].update({
                "status": "downloading",
                "progress": {
                    "percent": f"{percent}%",
                    "percent_num": percent,
                    "downloaded_bytes": downloaded,
                    "total_bytes": total,
                    "speed": strip_ansi(d.get("_speed_str", "")),
                    "eta": strip_ansi(d.get("_eta_str", "")),
                    "filename": os.path.basename(d.get("filename", "")),
                }
            })
        elif d["status"] == "finished":
            JOB_STORE[job_id]["status"] = "processing"
            JOB_STORE[job_id]["progress"] = {
                "percent": "100%",
                "percent_num": 100,
                "message": "Merging audio & video with FFmpeg..."
            }
        elif d["status"] == "error":
            JOB_STORE[job_id].update({
                "status": "failed",
                "error": strip_ansi(str(d.get("error", "Unknown error")))
            })
    return hook


def cleanup_job(job_id: str):
    """Remove temp files for a job from disk."""
    job = JOB_STORE.get(job_id)
    if job and job.get("output_dir") and os.path.exists(job["output_dir"]):
        try:
            shutil.rmtree(job["output_dir"], ignore_errors=True)
            logger.info(f"[{job_id}] Cleaned up temp files")
        except Exception as e:
            logger.warning(f"[{job_id}] Cleanup failed: {e}")


def download_thumbnail_to_job(
    url: str,
    job_dir: str,
    filename: str = "thumbnail.jpg",
    force_original: bool = False,
    video_url: Optional[str] = None,
) -> Optional[str]:
    """
    Download a thumbnail to the job directory.

    If force_original=True and video_url is provided, tries YouTube's native
    maxresdefault.jpg first (true original quality), then falls back through
    lower qualities until one succeeds. Skips YouTube's tiny placeholder images.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }

    urls_to_try = []

    # Priority 1: Construct native original-quality URLs from video ID
    if force_original and video_url:
        video_id = extract_video_id(video_url)
        if video_id:
            for quality_path in THUMB_QUALITY_PATHS:
                urls_to_try.append(f"https://i.ytimg.com/vi/{video_id}/{quality_path}")

    # Priority 2: The explicitly requested URL (from metadata)
    if url and url not in urls_to_try:
        urls_to_try.append(url)

    last_error = None
    for thumb_url in urls_to_try:
        try:
            response = requests.get(thumb_url, timeout=15, stream=True, headers=headers)

            # YouTube returns a tiny placeholder (~120x90) for missing qualities.
            # Real thumbnails are always > 2KB.
            content_length = int(response.headers.get("content-length", 0))
            if response.status_code == 200 and 0 < content_length < 2000:
                logger.info(f"[{os.path.basename(job_dir)}] Skipping placeholder ({content_length}B): {thumb_url}")
                continue

            response.raise_for_status()

            # Determine extension
            ext = ".jpg"
            if ".png" in thumb_url.lower():
                ext = ".png"
            elif ".webp" in thumb_url.lower():
                ext = ".webp"
            else:
                ct = response.headers.get("content-type", "")
                if "png" in ct:
                    ext = ".png"
                elif "webp" in ct:
                    ext = ".webp"

            # Filename includes quality name when using native URLs
            if force_original and "/vi/" in thumb_url:
                quality_name = thumb_url.split("/")[-1].split(".")[0]
                final_filename = f"thumbnail_{quality_name}{ext}"
            else:
                final_filename = filename if filename.endswith(ext) else filename.rsplit(".", 1)[0] + ext

            filepath = os.path.join(job_dir, final_filename)
            with open(filepath, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            actual_size = os.path.getsize(filepath)
            logger.info(f"[{os.path.basename(job_dir)}] Downloaded {actual_size / 1024:.1f}KB from {thumb_url}")
            return final_filename

        except Exception as e:
            last_error = e
            logger.warning(f"Thumbnail attempt failed ({thumb_url}): {e}")
            continue

    logger.error(f"All thumbnail attempts failed. Last error: {last_error}")
    return None


def _common_opts(output_dir: str, retries: int, job_id: str) -> dict:
    return {
        "outtmpl": os.path.join(output_dir, "%(title)s.%(ext)s"),
        "progress_hooks": [create_progress_hook(job_id)],
        "retries": retries,
        "fragment_retries": retries,
        "noplaylist": True,
        "windowsfilenames": True,
        "quiet": True,
        "no_warnings": True,
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        },
        "extractor_args": {
            "youtube": {
                "player_client": ["ios", "web", "mweb"],
            }
        },
        "socket_timeout": 30,
    }


def opts_best(output_dir, retries, job_id):
    opts = _common_opts(output_dir, retries, job_id)
    opts.update({
        "format": "bestvideo+bestaudio/best",
        "merge_output_format": "mp4",
        "postprocessors": [{"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}],
    })
    return opts


def opts_audio(output_dir, retries, job_id):
    opts = _common_opts(output_dir, retries, job_id)
    opts.update({
        "format": "bestaudio/best",
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }]
    })
    return opts


def opts_resolution(output_dir, resolution: str, retries, job_id):
    opts = _common_opts(output_dir, retries, job_id)
    opts.update({
        "format": f"bestvideo[height<={resolution}]+bestaudio/best[height<={resolution}]",
        "merge_output_format": "mp4",
    })
    return opts


def opts_keypad(output_dir, retries, job_id):
    opts = _common_opts(output_dir, retries, job_id)
    opts.update({
        "format": "worstvideo[height<=144]+worstaudio/worst[height<=144]/worst",
        "merge_output_format": "3gp",
        "postprocessors": [{"key": "FFmpegVideoConvertor", "preferedformat": "3gp"}],
        "postprocessor_args": [
            "-vf", "scale=176:144,fps=12",
            "-c:v", "h263", "-b:v", "80k",
            "-c:a", "libopencore_amrnb", "-b:a", "12.2k", "-ac", "1", "-ar", "8000",
        ],
    })
    return opts


def fetch_info(url: str) -> tuple[Optional[dict], Optional[str]]:
    """
    Fetch metadata. Returns (info_dict, None) on success, or (None, error_message) on failure.
    Uses cloud-friendly settings to avoid YouTube bot blocks.
    """
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        },
        "extractor_args": {
            "youtube": {"player_client": ["ios", "web", "mweb"]},
        },
        "socket_timeout": 30,
        "retries": 5,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            return (info, None)
    except yt_dlp.utils.DownloadError as e:
        err = str(e).split("ERROR:")[-1].strip()[:300] if "ERROR:" in str(e) else str(e)[:300]
        logger.error(f"Info fetch DownloadError: {err}")
        return (None, err)
    except Exception as e:
        logger.error(f"Info fetch failed: {e}")
        return (None, str(e)[:300])