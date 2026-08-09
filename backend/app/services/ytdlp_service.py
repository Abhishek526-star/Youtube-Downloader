import os
import re
import shutil
import logging
import tempfile
import threading
from typing import Dict, Any, Optional, Tuple
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


THUMB_QUALITY_PATHS = [
    "maxresdefault.jpg",
    "sddefault.jpg",
    "hqdefault.jpg",
    "mqdefault.jpg",
    "default.jpg",
]


class CancelledException(Exception):
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


# ──────────────────────────────────────────────
# Cookie-aware yt-dlp context manager
# Writes cookies to a TEMP file just for the duration of the `with` block,
# then securely deletes it. Cookies never persist on disk.
# ──────────────────────────────────────────────
class CookieContext:
    """
    Context manager that materializes in-memory cookies into a temporary file
    for yt-dlp, then wipes the file on exit. Use as:

        with CookieContext(cookies_text) as cookie_file:
            opts = {...}
            if cookie_file:
                opts["cookiefile"] = cookie_file
            with yt_dlp.YoutubeDL(opts) as ydl:
                ...
    """
    def __init__(self, cookies_text: Optional[str]):
        self.cookies_text = cookies_text
        self.tmp_path: Optional[str] = None

    def __enter__(self) -> Optional[str]:
        if not self.cookies_text:
            return None
        # Write to a temp file in the OS temp dir (auto-cleaned on reboot)
        fd, path = tempfile.mkstemp(prefix="yt-cookies-", suffix=".txt")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(self.cookies_text)
            os.chmod(path, 0o600)  # Owner-read only
            self.tmp_path = path
            logger.info(f"Cookies materialized to temp file (will be wiped on exit)")
            return path
        except Exception:
            # If anything fails, ensure no partial file lingers
            try:
                os.close(fd)
            except Exception:
                pass
            if os.path.exists(path):
                os.remove(path)
            raise

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.tmp_path and os.path.exists(self.tmp_path):
            try:
                # Overwrite before delete for extra safety
                with open(self.tmp_path, "w") as f:
                    f.write("")
                os.remove(self.tmp_path)
                logger.info("Temp cookie file securely wiped")
            except Exception as e:
                logger.warning(f"Failed to wipe temp cookie file: {e}")
        return False


# Shared cloud-friendly yt-dlp options
def _cloud_headers_and_clients() -> dict:
    return {
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        },
        "extractor_args": {
            "youtube": {"player_client": ["tv_embedded", "ios", "android", "web"]},
        },
        "socket_timeout": 30,
    }


def fetch_info(url: str, cookies_text: Optional[str] = None) -> Tuple[Optional[dict], Optional[str]]:
    """
    Fetch metadata. Returns (info_dict, None) on success, (None, error_message) on failure.
    If cookies_text is provided, uses it to bypass YouTube's bot wall.
    """
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "retries": 5,
        **_cloud_headers_and_clients(),
    }
    try:
        with CookieContext(cookies_text) as cookie_file:
            if cookie_file:
                ydl_opts["cookiefile"] = cookie_file
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


def download_thumbnail_to_job(
    url: str,
    job_dir: str,
    filename: str = "thumbnail.jpg",
    force_original: bool = False,
    video_url: Optional[str] = None,
) -> Optional[str]:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    urls_to_try = []
    if force_original and video_url:
        video_id = extract_video_id(video_url)
        if video_id:
            for quality_path in THUMB_QUALITY_PATHS:
                urls_to_try.append(f"https://i.ytimg.com/vi/{video_id}/{quality_path}")
    if url and url not in urls_to_try:
        urls_to_try.append(url)

    last_error = None
    for thumb_url in urls_to_try:
        try:
            response = requests.get(thumb_url, timeout=15, stream=True, headers=headers)
            content_length = int(response.headers.get("content-length", 0))
            if response.status_code == 200 and 0 < content_length < 2000:
                logger.info(f"[{os.path.basename(job_dir)}] Skipping placeholder ({content_length}B)")
                continue
            response.raise_for_status()

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
            logger.info(f"[{os.path.basename(job_dir)}] Downloaded {actual_size / 1024:.1f}KB thumbnail")
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
        **_cloud_headers_and_clients(),
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