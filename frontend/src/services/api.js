const API = import.meta.env.VITE_API_URL;

// Helper: throw a real Error with the backend's message on non-2xx responses
async function handleResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || data.detail?.[0]?.msg || `Request failed (${res.status})`;
    throw new Error(msg.replace('Value error, ', ''));
  }
  return data;
}

export const analyzeVideo = (url) =>
  fetch(`${API}/api/video/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.trim(), mode: 'best' })
  }).then(handleResponse);

export const startDownload = (params) =>
  fetch(`${API}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, url: params.url.trim() }),
  }).then(handleResponse);

export const cancelDownload = (jobId) =>
  fetch(`${API}/api/download/${jobId}/cancel`, { method: 'POST' })
    .then(handleResponse);

// Always requests TRUE ORIGINAL quality (maxresdefault) with automatic fallback
export const downloadThumbnail = (videoUrl, thumbnailUrl, originalQuality = true) =>
  fetch(`${API}/api/download/thumbnail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: videoUrl.trim(),
      thumbnail_url: thumbnailUrl,
      original_quality: originalQuality,
    }),
  }).then(handleResponse);

export const subscribeProgress = (jobId, cb) => {
  const es = new EventSource(`${API}/api/download/${jobId}/progress`);
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    cb(data);
    if (['completed', 'failed', 'cancelled'].includes(data.status)) es.close();
  };
  es.onerror = () => es.close();
};