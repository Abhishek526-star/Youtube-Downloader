const API = import.meta.env.VITE_API_URL;

async function handleResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || data.detail?.[0]?.msg || `Request failed (${res.status})`;
    throw new Error(msg.replace('Value error, ', ''));
  }
  return data;
}

// ✅ Upload cookies file → returns a session ID
export const uploadCookies = (file) => {
  const formData = new FormData();
  formData.append('file', file);
  return fetch(`${API}/api/cookies/upload`, {
    method: 'POST',
    body: formData,
  }).then(handleResponse);
};

export const clearCookies = (sessionId) =>
  fetch(`${API}/api/cookies/clear/${sessionId}`, { method: 'POST' })
    .then(handleResponse);

// ✅ Analyze now accepts an optional cookie session
export const analyzeVideo = (url, cookieSession = null) => {
  const body = { url: url.trim() };
  if (cookieSession) body.cookie_session = cookieSession;
  return fetch(`${API}/api/video/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handleResponse);
};

// ✅ Download uses multipart form so cookies session can be passed
export const startDownload = (params) => {
  const formData = new FormData();
  formData.append('url', params.url.trim());
  formData.append('mode', params.mode);
  if (params.resolution) formData.append('resolution', params.resolution);
  if (params.cookieSession) formData.append('cookie_session', params.cookieSession);
  return fetch(`${API}/api/download`, {
    method: 'POST',
    body: formData,
  }).then(handleResponse);
};

export const cancelDownload = (jobId) =>
  fetch(`${API}/api/download/${jobId}/cancel`, { method: 'POST' }).then(handleResponse);

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