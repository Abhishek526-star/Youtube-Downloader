from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .routes.download import router as download_router
import os

app = FastAPI(title="YouTube Downloader API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:5173")],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(download_router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "youtube-downloader"}