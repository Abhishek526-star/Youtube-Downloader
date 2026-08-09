import os
import logging
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from .routes.download import router as download_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="YouTube Downloader API")


# ✅ Parse allowed origins — supports comma-separated list + exact match
def get_allowed_origins():
    raw = os.getenv("FRONTEND_URL", "http://localhost:5173")
    origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    if "http://localhost:5173" not in origins:
        origins.append("http://localhost:5173")
    logger.info(f"CORS allowed origins: {origins}")
    return origins


ALLOWED_ORIGINS = get_allowed_origins()

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"https?://.*",  # Safety net fallback
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=600,
)


# ✅ Explicit preflight handler — guarantees OPTIONS always returns valid CORS headers
@app.options("/{full_path:path}")
async def preflight_handler(request: Request, full_path: str):
    origin = request.headers.get("origin", "")
    headers = {
        "Access-Control-Allow-Origin": origin if origin in ALLOWED_ORIGINS else ALLOWED_ORIGINS[0],
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "600",
    }
    return JSONResponse(content={}, status_code=200, headers=headers)


# ✅ Convert Pydantic validation errors into clean, user-friendly messages
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = exc.errors()
    msg = errors[0].get("msg", "Invalid input") if errors else "Invalid request"
    msg = msg.replace("Value error, ", "")
    return JSONResponse(
        status_code=400,
        content={"success": False, "error": msg, "detail": errors}
    )


app.include_router(download_router)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "youtube-downloader",
        "allowed_origins": ALLOWED_ORIGINS,
    }