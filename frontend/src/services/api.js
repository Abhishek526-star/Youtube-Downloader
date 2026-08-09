const API = import.meta.env.VITE_API_URL;

export const analyzeVideo = (url) =>
  fetch(`${API}/api/video/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, mode: 'best' })
  }).then(r => r.json());

export const startDownload = (params) =>
  fetch(`${API}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }).then(r => r.json());

export const cancelDownload = (jobId) =>
  fetch(`${API}/api/download/${jobId}/cancel`, { method: 'POST' })
    .then(r => r.json());

// Always requests TRUE ORIGINAL quality (maxresdefault) with automatic fallback
export const downloadThumbnail = (videoUrl, thumbnailUrl, originalQuality = true) =>
  fetch(`${API}/api/download/thumbnail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: videoUrl,
      thumbnail_url: thumbnailUrl,
      original_quality: originalQuality,
    }),
  }).then(r => r.json());

export const subscribeProgress = (jobId, cb) => {
  const es = new EventSource(`${API}/api/download/${jobId}/progress`);
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    cb(data);
    if (['completed', 'failed', 'cancelled'].includes(data.status)) es.close();
  };
};