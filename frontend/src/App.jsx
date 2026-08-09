import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Ban,
  Calendar,
  Check,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Cookie,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FileText,
  FileVideo,
  Gauge,
  HardDriveDownload,
  Heart,
  History,
  Image as ImageIcon,
  Info,
  Link2,
  Loader2,
  Music2,
  Play,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  User,
  Video,
  Wifi,
  X,
  XCircle,
  Zap,
} from 'lucide-react';

import {
  analyzeVideo,
  startDownload,
  subscribeProgress,
  cancelDownload,
  downloadThumbnail,
  uploadCookies,
  clearCookies,
} from './services/api';

const FORMAT_OPTIONS = [
  {
    id: 'best',
    label: 'Best Quality',
    icon: Sparkles,
    desc: 'Highest res + audio merged',
    accent: 'violet',
  },
  {
    id: 'audio',
    label: 'MP3 Audio',
    icon: Music2,
    desc: '192 kbps audio only',
    accent: 'fuchsia',
  },
  {
    id: 'keypad',
    label: '3GP Keypad',
    icon: Smartphone,
    desc: '176×144 for old phones',
    accent: 'emerald',
  },
];

const RECENT_KEY = 'yt-downloader-recent-v1';
const SETTINGS_KEY = 'yt-downloader-settings-v1';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i] || 'TB'}`;
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd || String(yyyymmdd).length !== 8) return null;
  const d = new Date(
    `${String(yyyymmdd).slice(0, 4)}-${String(yyyymmdd).slice(4, 6)}-${String(yyyymmdd).slice(6, 8)}`
  );
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return null;
  const total = Math.max(0, Number(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function getModeLabel(mode, resolution) {
  if (mode === 'resolution') return `${resolution || 'Auto'}p MP4`;
  if (mode === 'audio') return 'MP3 Audio';
  if (mode === 'keypad') return '3GP Keypad';
  return 'Best Quality';
}

function safeReadStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [url, setUrl] = useState('');
  const [info, setInfo] = useState(null);

  const [mode, setMode] = useState('best');
  const [resolution, setResolution] = useState(null);

  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [showThumbs, setShowThumbs] = useState(false);

  const [cancelling, setCancelling] = useState(false);
  const [thumbDownloading, setThumbDownloading] = useState(null);

  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [history, setHistory] = useState([]);
  const [settings, setSettings] = useState({
    compactMode: false,
    autoDownload: true,
  });

  const [copiedField, setCopiedField] = useState(null);

  // ✅ Cookie state
  const [useCookies, setUseCookies] = useState(false);
  const [cookieSession, setCookieSession] = useState(null);
  const [cookieFileName, setCookieFileName] = useState(null);
  const [cookieUploading, setCookieUploading] = useState(false);
  const [showCookieHelp, setShowCookieHelp] = useState(false);

  const iframeRef = useRef(null);
  const inputRef = useRef(null);
  const cookieInputRef = useRef(null);

  useEffect(() => {
    setHistory(safeReadStorage(RECENT_KEY, []));
    setSettings(
      safeReadStorage(SETTINGS_KEY, {
        compactMode: false,
        autoDownload: true,
      })
    );
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Ignore localStorage failures.
    }
  }, [settings]);

  useEffect(() => {
    if (progress?.status !== 'completed' || !job || downloadUrl) return;

    const fileUrl = `${import.meta.env.VITE_API_URL}/api/download/${job}/file`;

    setDownloadUrl(fileUrl);
    setThumbDownloading(null);

    if (settings.autoDownload && iframeRef.current) {
      iframeRef.current.src = fileUrl;
    }

    if (info) {
      const item = {
        id: `${Date.now()}-${job}`,
        title: info.title || 'Untitled video',
        thumbnail: info.thumbnail || null,
        format: getModeLabel(mode, resolution),
        url: url.trim(),
        timestamp: Date.now(),
      };

      setHistory((prev) => {
        const next = [item, ...prev.filter((x) => x.title !== item.title)].slice(0, 12);
        try {
          localStorage.setItem(RECENT_KEY, JSON.stringify(next));
        } catch {
          // Ignore storage failures.
        }
        return next;
      });
    }
  }, [progress?.status, job, downloadUrl, settings.autoDownload, info, mode, resolution]);

  // ✅ Cookie upload handler
  const handleCookieUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setCookieUploading(true);
    try {
      const res = await uploadCookies(file);
      setCookieSession(res.cookie_session);
      setCookieFileName(file.name);
      setUseCookies(true);
    } catch (err) {
      setError(err.message || 'Failed to upload cookies');
      setUseCookies(false);
    }
    setCookieUploading(false);
    // Reset file input so same file can be re-selected
    if (cookieInputRef.current) cookieInputRef.current.value = '';
  };

  const handleClearCookies = async () => {
    if (cookieSession) {
      try { await clearCookies(cookieSession); } catch {}
    }
    setCookieSession(null);
    setCookieFileName(null);
    setUseCookies(false);
  };

  const isActive =
    progress &&
    !['completed', 'failed', 'cancelled'].includes(progress.status);

  const isThumbJob = Boolean(job?.startsWith('thumb-'));
  const activeThumbKey = info?.original_thumbnail || info?.thumbnail;

  const formatOptions = useMemo(() => {
    const resOptions = (info?.available_resolutions || []).map((r) => ({
      id: 'resolution',
      value: r,
      label: `${r}p`,
      icon: FileVideo,
      desc: `MP4 • ${r}p`,
      accent: 'blue',
    }));

    return [
      ...FORMAT_OPTIONS.slice(0, 1),
      ...resOptions,
      ...FORMAT_OPTIONS.slice(1),
    ];
  }, [info]);

  const selectedFormatLabel = getModeLabel(mode, resolution);

  const progressPercent = Math.min(
    100,
    Math.max(0, Number(progress?.progress?.percent_num ?? 0))
  );

  const handleAnalyze = async () => {
    if (!url.trim() || loading || job) return;

    setLoading(true);
    setError(null);
    setInfo(null);
    setDownloadUrl(null);
    setProgress(null);

    try {
      const data = await analyzeVideo(url.trim(), useCookies ? cookieSession : null);
      setInfo(data);

      if (data.available_resolutions?.length) {
        setResolution(data.available_resolutions[0]);
      }
      // Cookies are one-time-use; clear session after analyze consumed them
      if (useCookies && cookieSession) {
        setCookieSession(null);
        setCookieFileName(null);
        setUseCookies(false);
      }
    } catch (err) {
      setError(err.message || 'Invalid YouTube URL or the video is restricted.');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!url.trim() || !info || loading) return;

    setError(null);
    setDownloadUrl(null);
    setProgress(null);
    setCancelling(false);

    try {
      const params = { url: url.trim(), mode, cookieSession: useCookies ? cookieSession : null };

      if (mode === 'resolution') {
        params.resolution = resolution;
      }

      const { job_id } = await startDownload(params);
      setJob(job_id);
      
      // Cookies consumed by download; clear UI state
      if (useCookies && cookieSession) {
        setCookieSession(null);
        setCookieFileName(null);
        setUseCookies(false);
      }

      subscribeProgress(job_id, (data) => {
        setProgress(data);

        if (data.status === 'failed') {
          setError(data.error || 'Download failed.');
        }
      });
    } catch (err) {
      setError(err.message || 'Backend unreachable. Make sure the API server is running.');
    }
  };

  const handleThumbDownload = async (thumbUrl) => {
    if (!thumbUrl) return;

    setError(null);
    setThumbDownloading(thumbUrl);
    setDownloadUrl(null);
    setProgress(null);
    setCancelling(false);

    try {
      const { job_id } = await downloadThumbnail(url.trim(), thumbUrl, true);
      setJob(job_id);

      subscribeProgress(job_id, (data) => {
        setProgress(data);

        if (data.status === 'failed') {
          setError(data.error || 'Thumbnail download failed.');
          setThumbDownloading(null);
        }
      });
    } catch (err) {
      setError(err.message || 'Could not download thumbnail.');
      setThumbDownloading(null);
    }
  };

  const handleCancel = async () => {
    if (!job || cancelling) return;

    setCancelling(true);

    try {
      await cancelDownload(job);
    } catch {
      setError('Could not cancel the download.');
      setCancelling(false);
    }
  };

  const resetAll = () => {
    setUrl('');
    setInfo(null);
    setJob(null);
    setProgress(null);
    setDownloadUrl(null);
    setError(null);
    setShowThumbs(false);
    setCancelling(false);
    setThumbDownloading(null);

    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const clearHistory = () => {
    setHistory([]);
    try {
      localStorage.removeItem(RECENT_KEY);
    } catch {
      // Ignore storage failures.
    }
  };

  const restoreHistoryItem = (item) => {
    setUrl(item.url || '');
    setShowHistory(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleCopy = (text, field) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#060608] text-zinc-100 antialiased selection:bg-violet-500/30 selection:text-white">
      <iframe
        ref={iframeRef}
        title="download-trigger"
        className="hidden"
        aria-hidden="true"
      />

      {/* Premium layered ambient lighting */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-[-380px] h-[760px] w-[1180px] -translate-x-1/2 rounded-full bg-violet-600/[0.14] blur-[160px]" />
        <div className="absolute left-[-280px] top-[28%] h-[620px] w-[620px] rounded-full bg-indigo-600/[0.08] blur-[160px]" />
        <div className="absolute bottom-[-300px] right-[-220px] h-[680px] w-[680px] rounded-full bg-fuchsia-600/[0.06] blur-[170px]" />
        <div className="absolute left-1/2 top-0 h-[200px] w-[800px] -translate-x-1/2 bg-gradient-to-b from-white/[0.03] to-transparent" />
        <div
          className="absolute inset-0 opacity-[0.15]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.02) 1px, transparent 1px)',
            backgroundSize: '52px 52px',
            maskImage:
              'radial-gradient(ellipse 100% 80% at 50% 0%, black 40%, transparent 85%)',
          }}
        />
      </div>

      {/* Top navigation */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#060608]/70 backdrop-blur-2xl supports-[backdrop-filter]:bg-[#060608]/55">
        <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-10">
          <button
            onClick={resetAll}
            className="group flex items-center gap-3.5 text-left transition active:scale-[0.98]"
          >
            <div className="relative flex h-10 w-10 items-center justify-center rounded-[13px] bg-gradient-to-br from-violet-500 via-purple-500 to-fuchsia-500 shadow-lg shadow-violet-900/40 transition-transform group-hover:scale-105">
              <Play className="h-[18px] w-[18px] fill-white text-white" />
              <span className="absolute inset-0 rounded-[13px] ring-1 ring-inset ring-white/20" />
              <span className="absolute inset-0 rounded-[13px] bg-gradient-to-t from-black/30 to-transparent" />
            </div>

            <div className="leading-none">
              <div className="text-[17px] font-bold tracking-[-0.02em] text-white">
                Pulse<span className="text-zinc-500">Downloader</span>
              </div>
              <div className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.22em] text-zinc-600">
                Premium • Fast • Free
              </div>
            </div>
          </button>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-full border border-emerald-400/15 bg-emerald-400/[0.04] px-3 py-1.5 text-[11px] font-semibold text-emerald-300/90 sm:flex">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              All systems operational
            </div>

            <button
              onClick={() => setShowHistory(true)}
              className="flex h-10 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 text-[13px] font-semibold text-zinc-300 transition hover:border-white/[0.14] hover:bg-white/[0.05] hover:text-white active:scale-[0.98]"
            >
              <History className="h-[17px] w-[17px]" />
              <span className="hidden sm:inline">History</span>
            </button>

            <button
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] text-zinc-300 transition hover:border-white/[0.14] hover:bg-white/[0.05] hover:text-white active:scale-[0.98]"
            >
              <Settings className="h-[17px] w-[17px]" />
            </button>
          </div>
        </div>
      </header>

      <main className="relative mx-auto w-full max-w-[1440px] px-4 pb-20 pt-6 sm:px-7 lg:px-10">
        {/* Hero label */}
        <div className="mb-5 flex flex-col items-center text-center sm:mb-7">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-[11px] font-semibold text-zinc-400 backdrop-blur-sm">
            <Sparkles className="h-3 w-3 text-violet-400" />
            Next-gen video downloader
            <span className="h-1 w-1 rounded-full bg-zinc-700" />
            <span className="text-emerald-400">No signup required</span>
          </div>
          <h1 className="mt-4 text-balance text-3xl font-bold tracking-[-0.03em] text-white sm:text-4xl lg:text-[42px] lg:leading-[1.1]">
            Download videos in
            <span className="bg-gradient-to-r from-violet-400 via-fuchsia-400 to-violet-400 bg-clip-text text-transparent">
              {' '}studio quality
            </span>
          </h1>
          <p className="mt-3 max-w-md text-pretty text-sm text-zinc-500 sm:text-[15px]">
            Paste any YouTube link to analyze, preview, and export in your preferred format — built for speed.
          </p>
        </div>

        {/* Main glass shell */}
        <div className="relative overflow-hidden rounded-[24px] border border-white/[0.07] bg-gradient-to-b from-white/[0.025] to-white/[0.008] shadow-[0_40px_120px_-20px_rgba(0,0,0,.6),0_0_0_1px_rgba(255,255,255,.02)_inset] backdrop-blur-xl">
          {/* Top sheen */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />

          {/* URL / search bar */}
          <section className="border-b border-white/[0.05] p-4 sm:p-5 lg:p-6">
            <div className="flex flex-col gap-3 lg:flex-row">
              <div className="group relative flex min-h-[60px] flex-1 items-center gap-3 rounded-2xl border border-white/[0.09] bg-[#0a0a0d] px-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] transition focus-within:border-violet-400/40 focus-within:bg-[#0c0c11] focus-within:ring-4 focus-within:ring-violet-500/[0.08]">
                <Link2 className="h-[18px] w-[18px] shrink-0 text-zinc-600 transition group-focus-within:text-violet-400" />

                <input
                  ref={inputRef}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAnalyze();
                  }}
                  placeholder="Paste YouTube video URL here..."
                  className="min-w-0 flex-1 bg-transparent text-[15px] font-medium text-white outline-none placeholder:text-zinc-600"
                  disabled={Boolean(job)}
                />

                {url && !job && (
                  <button
                    onClick={() => setUrl('')}
                    className="rounded-lg p-1.5 text-zinc-600 transition hover:bg-white/[0.05] hover:text-white"
                    aria-label="Clear URL"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              <button
                onClick={handleAnalyze}
                disabled={loading || Boolean(job) || !url.trim()}
                className="group relative flex h-[60px] items-center justify-center gap-2.5 overflow-hidden rounded-2xl bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 px-7 text-[15px] font-bold text-white shadow-[0_8px_30px_-8px_rgba(139,92,246,0.6)] transition hover:shadow-[0_12px_40px_-8px_rgba(139,92,246,0.7)] hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none lg:min-w-[220px]"
              >
                <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
                {loading ? (
                  <Loader2 className="h-[18px] w-[18px] animate-spin" />
                ) : (
                  <Search className="h-[18px] w-[18px]" />
                )}
                {loading ? 'Analyzing...' : 'Analyze'}
              </button>
            </div>

            {/* ✅ COOKIE TOGGLE SECTION */}
            <div className="mt-4 rounded-2xl border border-white/[0.06] bg-[#08080b] p-4 sm:p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition ${useCookies && cookieSession ? 'bg-amber-400/15 text-amber-300' : 'bg-white/[0.04] text-zinc-500'}`}>
                    <Cookie className="h-[18px] w-[18px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[13px] font-bold text-white">Use YouTube Cookies</h3>
                      <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-zinc-500">
                        Optional
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-5 text-zinc-500">
                      Bypass YouTube's "confirm you're not a bot" block for restricted videos.
                    </p>
                  </div>
                </div>

                {/* Toggle switch */}
                <button
                  onClick={() => {
                    if (useCookies) { handleClearCookies(); }
                    else { cookieInputRef.current?.click(); }
                  }}
                  disabled={cookieUploading || !!job}
                  className={`relative h-6 w-11 shrink-0 rounded-full p-0.5 transition ${useCookies && cookieSession ? 'bg-violet-500' : 'bg-white/[0.1]'} disabled:opacity-50`}
                  aria-label="Toggle cookies"
                >
                  <span className={`block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ${useCookies && cookieSession ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {/* Hidden file input */}
              <input ref={cookieInputRef} type="file" accept=".txt,text/plain" onChange={handleCookieUpload} className="hidden" />

              {/* Cookie status / upload area */}
              {useCookies && !cookieSession && (
                <button onClick={() => cookieInputRef.current?.click()} disabled={cookieUploading || !!job}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-white/[0.08] bg-white/[0.015] p-4 text-[13px] font-medium text-zinc-400 transition hover:border-violet-400/30 hover:text-white disabled:opacity-50">
                  {cookieUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {cookieUploading ? 'Loading cookies...' : 'Click to upload cookies.txt'}
                </button>
              )}

              {cookieSession && (
                <div className="mt-4 flex items-center justify-between rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" />
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-[13px] font-medium text-emerald-200">
                        <FileText className="h-3.5 w-3.5" />
                        <span className="truncate">{cookieFileName}</span>
                      </p>
                      <p className="text-[11px] text-zinc-500">Loaded in memory • used once • auto-deleted</p>
                    </div>
                  </div>
                  <button onClick={handleClearCookies} disabled={!!job} className="text-zinc-600 transition hover:text-red-300 disabled:opacity-50" title="Remove cookies">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}

              {/* Help accordion */}
              <div className="mt-4 border-t border-white/[0.06] pt-3">
                <button onClick={() => setShowCookieHelp(!showCookieHelp)} className="flex items-center gap-1 text-[11px] text-zinc-500 transition hover:text-zinc-300">
                  {showCookieHelp ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  How do I export my cookies?
                </button>
                {showCookieHelp && (
                  <div className="mt-3 space-y-2 text-[12px] leading-relaxed text-zinc-400">
                    <ol className="list-inside list-decimal space-y-1.5 pl-1">
                      <li>Install the free browser extension <span className="font-medium text-violet-300">"Get cookies.txt LOCALLY"</span> (Chrome / Firefox / Edge).</li>
                      <li>Open <span className="text-white">youtube.com</span> and make sure you're signed in.</li>
                      <li>Click the extension icon → <span className="text-white">Export</span> → save the <span className="text-white">cookies.txt</span> file.</li>
                      <li>Upload that file here using the toggle above.</li>
                    </ol>
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] p-2.5">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                      <p className="text-amber-300/80">
                        <span className="font-semibold">Privacy:</span> Your cookies grant full account access. They are kept in server memory only, used for a single request, then permanently deleted. Never upload cookies on a public/shared site — only use this on a tool you trust.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Error */}
          {error && (
            <div className="mx-4 mt-4 flex items-start gap-3 rounded-2xl border border-red-400/15 bg-red-500/[0.04] p-4 sm:mx-6">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-500/10">
                <AlertCircle className="h-4 w-4 text-red-300" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-red-100">
                  Something went wrong
                </p>
                <p className="mt-1 text-xs leading-5 text-red-300/70">
                  {error}
                </p>
              </div>
              <button
                onClick={() => setError(null)}
                className="ml-auto rounded-lg p-1 text-red-300/60 transition hover:bg-white/[0.05] hover:text-red-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Video analyzed state */}
          {info && !job && !downloadUrl && (
            <section className="p-4 sm:p-6 lg:p-7">
              <div className="grid gap-5 xl:grid-cols-[1.05fr_1.25fr]">
                {/* Preview & Channel Info */}
                <div className="min-w-0 space-y-3">
                  <div className="group relative aspect-video overflow-hidden rounded-2xl border border-white/[0.07] bg-black shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]">
                    <img
                      src={info.thumbnail}
                      alt={info.title || 'Video thumbnail'}
                      className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.03]"
                    />

                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/5 to-transparent" />

                    <div className="absolute left-4 top-4 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white/85 backdrop-blur-md">
                      <Video className="h-2.5 w-2.5" />
                      Preview
                    </div>

                    {info.duration && (
                      <div className="absolute bottom-4 right-4 rounded-md border border-white/10 bg-black/70 px-2 py-1 text-[11px] font-bold tabular-nums backdrop-blur-md">
                        {formatDuration(info.duration)}
                      </div>
                    )}

                    <div className="absolute bottom-4 left-4 right-20 flex translate-y-2 items-center gap-2 opacity-0 transition duration-300 group-hover:translate-y-0 group-hover:opacity-100">
                      <button
                        onClick={() => handleThumbDownload(activeThumbKey)}
                        disabled={thumbDownloading === activeThumbKey}
                        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/65 px-3 py-2 text-[11px] font-bold backdrop-blur-md transition hover:bg-black/85 disabled:opacity-50"
                      >
                        {thumbDownloading === activeThumbKey ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Download className="h-3 w-3" />
                        )}
                        Thumbnail
                      </button>

                      {info.thumbnails?.length > 0 && (
                        <button
                          onClick={() => setShowThumbs((v) => !v)}
                          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/65 px-3 py-2 text-[11px] font-bold backdrop-blur-md transition hover:bg-black/85"
                        >
                          <ImageIcon className="h-3 w-3" />
                          {showThumbs ? 'Hide' : 'All sizes'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Dedicated Original Thumbnail Callout */}
                  <div className="flex items-center justify-between p-3.5 rounded-2xl border border-violet-400/15 bg-violet-400/[0.04]">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-400/10">
                        <ImageIcon className="h-4 w-4 text-violet-300" />
                      </div>
                      <div>
                        <p className="text-[13px] font-bold text-white">Original Thumbnail</p>
                        <p className="text-[11px] text-zinc-500">maxresdefault • 1280×720 • Full quality</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleThumbDownload(activeThumbKey)}
                      disabled={thumbDownloading === activeThumbKey}
                      className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-white/20 active:scale-95 disabled:opacity-50"
                    >
                      {thumbDownloading === activeThumbKey ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Download className="h-3 w-3" />
                      )}
                      Save
                    </button>
                  </div>

                  {/* Channel */}
                  <div className="flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3.5">
                    {info.channel_logo ? (
                      <img
                        src={info.channel_logo}
                        alt=""
                        className="h-10 w-10 rounded-full bg-white/[0.05] object-cover ring-1 ring-white/10"
                      />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.05]">
                        <User className="h-4 w-4 text-zinc-500" />
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-white">
                        {info.uploader || 'Unknown Channel'}
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                        {info.subscriber_count && (
                          <span>
                            {Number(info.subscriber_count).toLocaleString()} subscribers
                          </span>
                        )}

                        {info.channel_url && (
                          <>
                            <span className="text-zinc-700">•</span>
                            <a
                              href={info.channel_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 transition hover:text-violet-300"
                            >
                              Channel
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          </>
                        )}
                      </div>
                    </div>

                    <ShieldCheck className="hidden h-4 w-4 text-emerald-400/70 sm:block" />
                  </div>
                </div>

                {/* Details / formats */}
                <div className="min-w-0 rounded-2xl border border-white/[0.06] bg-[#08080b] p-5 sm:p-6">
                  <div className="flex flex-wrap gap-1.5">
                    <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                      YouTube
                    </span>
                    {info.duration && (
                      <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[10px] font-bold tabular-nums text-zinc-500">
                        {formatDuration(info.duration)}
                      </span>
                    )}
                    {info.view_count && (
                      <span className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[10px] font-bold text-zinc-500">
                        <Eye className="h-2.5 w-2.5" />
                        {Number(info.view_count).toLocaleString()}
                      </span>
                    )}
                    {info.upload_date && (
                      <span className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[10px] font-bold text-zinc-500">
                        <Calendar className="h-2.5 w-2.5" />
                        {formatDate(info.upload_date)}
                      </span>
                    )}
                  </div>

                  <h2 className="mt-4 text-balance text-xl font-bold leading-7 tracking-[-0.02em] text-white sm:text-[22px]">
                    {info.title}
                  </h2>

                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-500">
                    {info.like_count && (
                      <span className="flex items-center gap-1.5">
                        <Heart className="h-3 w-3" />
                        {Number(info.like_count).toLocaleString()} likes
                      </span>
                    )}

                    {info.categories?.length > 0 && (
                      <span className="truncate">
                        {info.categories.slice(0, 3).join(' • ')}
                      </span>
                    )}
                  </div>

                  {/* Format selector */}
                  <div className="mt-6">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
                          Format & quality
                        </p>
                        <p className="mt-1 text-[11px] text-zinc-700">
                          Choose your output
                        </p>
                      </div>

                      <div className="rounded-full border border-violet-400/15 bg-violet-400/[0.05] px-2.5 py-1 text-[10px] font-semibold text-violet-300">
                        {formatOptions.length} options
                      </div>
                    </div>

                    <div className="grid max-h-[310px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
                      {formatOptions.map((opt) => {
                        const isSelected =
                          opt.id === 'resolution'
                            ? mode === 'resolution' && resolution === opt.value
                            : mode === opt.id;

                        const Icon = opt.icon;

                        return (
                          <button
                            key={opt.id + (opt.value || '')}
                            onClick={() => {
                              setMode(opt.id);
                              if (opt.value) setResolution(opt.value);
                            }}
                            className={`group relative flex min-h-[80px] items-center gap-3 overflow-hidden rounded-xl border p-3 text-left transition-all duration-200 active:scale-[0.98] ${
                              isSelected
                                ? 'border-violet-400/40 bg-gradient-to-br from-violet-500/[0.12] to-fuchsia-500/[0.05] shadow-[0_8px_24px_-8px_rgba(139,92,246,0.4)]'
                                : 'border-white/[0.06] bg-white/[0.015] hover:border-white/[0.12] hover:bg-white/[0.035]'
                            }`}
                          >
                            {isSelected && (
                              <span className="absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-violet-500 text-white shadow-lg shadow-violet-900/50">
                                <Check className="h-2.5 w-2.5" />
                              </span>
                            )}

                            <div
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition ${
                                isSelected
                                  ? 'bg-violet-400/15 text-violet-300'
                                  : 'bg-white/[0.04] text-zinc-400 group-hover:text-zinc-200'
                              }`}
                            >
                              <Icon className="h-[18px] w-[18px]" />
                            </div>

                            <div className="min-w-0 pr-5">
                              <div
                                className={`text-[13px] font-bold ${
                                  isSelected ? 'text-white' : 'text-zinc-300'
                                }`}
                              >
                                {opt.label}
                              </div>
                              <p className="mt-0.5 truncate text-[10px] text-zinc-600">
                                {opt.desc}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <button
                    onClick={handleDownload}
                    className="group relative mt-5 flex h-[52px] w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 text-sm font-bold text-white shadow-[0_10px_40px_-10px_rgba(139,92,246,0.6)] transition hover:shadow-[0_14px_50px_-10px_rgba(139,92,246,0.7)] hover:brightness-110 active:scale-[0.99]"
                  >
                    <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
                    <Download className="h-4 w-4" />
                    Download {selectedFormatLabel}
                    <span className="ml-1 rounded-md bg-white/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                      Start
                    </span>
                  </button>
                </div>
              </div>

              {/* Separate Section for Description & Tags */}
              {(info.description || info.tags?.length > 0) && (
                <div className="mt-5 grid gap-5 lg:grid-cols-[1.6fr_1fr]">
                  {/* Description Card */}
                  {info.description && (
                    <div className="flex flex-col rounded-2xl border border-white/[0.06] bg-[#08080b] p-5 sm:p-6">
                      <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-violet-300" />
                          <h3 className="text-[13px] font-bold uppercase tracking-[0.12em] text-zinc-400">
                            Description
                          </h3>
                        </div>
                        <button
                          onClick={() => handleCopy(info.description, 'description')}
                          className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 text-[11px] font-semibold text-zinc-400 transition hover:border-white/[0.12] hover:bg-white/[0.05] hover:text-white active:scale-[0.98]"
                        >
                          {copiedField === 'description' ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                          {copiedField === 'description' ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <div className="mt-4 flex-1 overflow-y-auto pr-2">
                        <p className="max-h-48 whitespace-pre-wrap text-[13px] leading-6 text-zinc-400">
                          {info.description}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Tags Card */}
                  {info.tags?.length > 0 && (
                    <div className="flex flex-col rounded-2xl border border-white/[0.06] bg-[#08080b] p-5 sm:p-6">
                      <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                        <div className="flex items-center gap-2">
                          <Tag className="h-4 w-4 text-fuchsia-300" />
                          <h3 className="text-[13px] font-bold uppercase tracking-[0.12em] text-zinc-400">
                            Tags
                          </h3>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="hidden rounded-full border border-white/[0.06] bg-white/[0.025] px-2 py-0.5 text-[10px] font-bold text-zinc-500 sm:inline-block">
                            {info.tags.length} total
                          </span>
                          <button
                            onClick={() => handleCopy(info.tags.map(t => `#${t}`).join(' '), 'tags')}
                            className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 text-[11px] font-semibold text-zinc-400 transition hover:border-white/[0.12] hover:bg-white/[0.05] hover:text-white active:scale-[0.98]"
                          >
                            {copiedField === 'tags' ? (
                              <Check className="h-3 w-3 text-emerald-400" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                            {copiedField === 'tags' ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                      </div>
                      <div className="mt-4 flex max-h-48 flex-wrap gap-2 overflow-y-auto pr-1">
                        {info.tags.map((tag, i) => (
                          <span
                            key={`${tag}-${i}`}
                            className="inline-flex items-center rounded-full border border-white/[0.06] bg-white/[0.025] px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition hover:border-violet-400/30 hover:bg-violet-400/[0.08] hover:text-violet-200"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Separate Section for Channel Assets & Thumbnail Gallery */}
              {(info.channel_banner || info.channel_tags?.length > 0 || (showThumbs && info.thumbnails?.length > 0)) && (
                <div className="mt-5 grid gap-5 lg:grid-cols-2">
                  
                  {/* Channel Assets Card (Banner + Channel Keywords) */}
                  {(info.channel_banner || info.channel_tags?.length > 0) && (
                    <div className="flex flex-col rounded-2xl border border-white/[0.06] bg-[#08080b] p-5 sm:p-6">
                      <div className="flex items-center gap-2 border-b border-white/[0.06] pb-3">
                        <User className="h-4 w-4 text-fuchsia-300" />
                        <h3 className="text-[13px] font-bold uppercase tracking-[0.12em] text-zinc-400">
                          Channel Assets
                        </h3>
                      </div>

                      <div className="mt-4 space-y-4">
                        {info.channel_banner && (
                          <div className="overflow-hidden rounded-xl border border-white/[0.06]">
                            <img
                              src={info.channel_banner}
                              alt="Channel banner"
                              className="h-24 w-full object-cover transition duration-500 hover:scale-105"
                            />
                          </div>
                        )}

                        {info.channel_tags && info.channel_tags.length > 0 && (
                          <div>
                            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
                              Channel Keywords
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {info.channel_tags.slice(0, 10).map((tag, i) => (
                                <span
                                  key={i}
                                  className="rounded-md border border-violet-400/15 bg-violet-400/[0.05] px-2 py-0.5 text-[11px] font-medium text-violet-300"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Thumbnail Gallery */}
                  {showThumbs && info.thumbnails?.length > 0 && (
                    <div className="flex flex-col rounded-2xl border border-white/[0.06] bg-[#08080b] p-5 sm:p-6">
                      <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                        <div className="flex items-center gap-2">
                          <ImageIcon className="h-4 w-4 text-violet-300" />
                          <h3 className="text-[13px] font-bold uppercase tracking-[0.12em] text-zinc-400">
                            Thumbnail Gallery
                          </h3>
                        </div>
                        <span className="rounded-full border border-white/[0.06] bg-white/[0.025] px-2 py-0.5 text-[10px] font-bold text-zinc-500">
                          {info.thumbnails.length} images
                        </span>
                      </div>

                      <div className="mt-4 grid grid-cols-3 gap-2.5 overflow-y-auto pr-1">
                        {info.thumbnails.slice(0, 9).map((t, i) => (
                          <div
                            key={i}
                            className="group relative aspect-video overflow-hidden rounded-xl border border-white/[0.06] bg-black transition hover:border-violet-400/30 hover:shadow-[0_10px_30px_-10px_rgba(139,92,246,0.4)]"
                          >
                            <img
                              src={t}
                              alt=""
                              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                              loading="lazy"
                            />
                            <span className="absolute left-1.5 top-1.5 rounded border border-white/10 bg-black/60 px-1.5 py-0.5 text-[9px] font-bold text-white/80 backdrop-blur-md">
                              {i === 0 ? 'Original' : `#${i + 1}`}
                            </span>
                            <div className="absolute inset-0 flex items-center justify-center bg-black/70 opacity-0 transition group-hover:opacity-100">
                              <button
                                onClick={() => handleThumbDownload(i === 0 ? (info.original_thumbnail || t) : t)}
                                disabled={thumbDownloading === t || thumbDownloading === info.original_thumbnail}
                                className="flex items-center gap-1.5 rounded-lg bg-white/15 px-2.5 py-1.5 text-[10px] font-bold backdrop-blur-md transition hover:bg-white/30 disabled:opacity-50"
                              >
                                {(thumbDownloading === t || (i === 0 && thumbDownloading === info.original_thumbnail)) ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Download className="h-3 w-3" />
                                )}
                                Save
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Active download */}
          {isActive && (
            <section className="p-4 sm:p-6 lg:p-7">
              <div className="relative overflow-hidden rounded-[24px] border border-violet-400/20 bg-gradient-to-br from-violet-500/[0.07] via-[#08080b] to-fuchsia-500/[0.04] shadow-[0_30px_80px_-20px_rgba(0,0,0,.6)]">
                <div className="pointer-events-none absolute -right-32 -top-32 h-72 w-72 rounded-full bg-violet-500/10 blur-3xl" />
                <div className="pointer-events-none absolute -bottom-40 left-1/4 h-72 w-72 rounded-full bg-fuchsia-500/10 blur-3xl" />
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-400/30 to-transparent" />

                <div className="relative p-5 sm:p-7 lg:p-8">
                  <div className="flex items-start justify-between gap-5">
                    <div className="flex min-w-0 items-center gap-4">
                      <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-violet-400/10 ring-1 ring-violet-400/15">
                        {isThumbJob ? (
                          <ImageIcon className="h-6 w-6 text-violet-300" />
                        ) : (
                          <Loader2 className="h-6 w-6 animate-spin text-violet-300" />
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-violet-400/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-violet-300">
                            {isThumbJob ? 'Thumbnail' : 'Downloading'}
                          </span>

                          {progress.status === 'cancelling' && (
                            <span className="rounded-full bg-orange-400/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-300">
                              Cancelling
                            </span>
                          )}
                        </div>

                        <p className="mt-2 truncate text-base font-bold tracking-tight text-white sm:text-lg">
                          {progress.progress?.filename ||
                            (isThumbJob ? 'Thumbnail download' : `Job ${job}`)}
                        </p>

                        <p className="mt-1 truncate text-xs text-zinc-500 sm:text-[13px]">
                          {progress.status === 'cancelling'
                            ? 'Cancelling download...'
                            : progress.status === 'processing'
                              ? progress.progress?.message || 'Processing your download...'
                              : progressPercent >= 100
                                ? 'Saving to your device...'
                                : isThumbJob
                                  ? 'Downloading thumbnail...'
                                  : progress.status}
                        </p>
                      </div>
                    </div>

                    {!isThumbJob && progress.status !== 'cancelling' && (
                      <button
                        onClick={handleCancel}
                        disabled={cancelling}
                        className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-red-400/20 bg-red-400/[0.05] px-3 py-2 text-xs font-bold text-red-300 transition hover:border-red-400/35 hover:bg-red-400/[0.1] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {cancelling ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Ban className="h-3.5 w-3.5" />
                        )}
                        <span className="hidden sm:inline">Cancel</span>
                      </button>
                    )}
                  </div>

                  {!isThumbJob && (
                    <>
                      <div className="mt-8 flex items-end justify-between gap-4">
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-600">
                            Current download
                          </p>
                          <p className="mt-1.5 text-2xl font-bold tabular-nums text-white sm:text-[28px]">
                            {formatBytes(progress.progress?.downloaded_bytes)}
                            <span className="ml-2 text-sm font-medium text-zinc-600 sm:text-[15px]">
                              / {formatBytes(progress.progress?.total_bytes)}
                            </span>
                          </p>
                        </div>

                        <span className="text-4xl font-bold tabular-nums tracking-[-0.04em] text-white sm:text-[44px]">
                          {progress.progress?.percent || `${progressPercent}%`}
                        </span>
                      </div>

                      <div className="relative mt-5 h-2.5 overflow-hidden rounded-full bg-white/[0.05]">
                        <div
                          className={`relative h-full rounded-full transition-[width] duration-500 ${
                            progress.status === 'cancelling'
                              ? 'bg-gradient-to-r from-orange-500 to-red-500'
                              : 'bg-gradient-to-r from-fuchsia-500 via-violet-500 to-blue-400'
                          }`}
                          style={{ width: `${progressPercent}%` }}
                        >
                          {!isThumbJob && progress.status !== 'cancelling' && (
                            <span className="absolute inset-0 rounded-full bg-gradient-to-r from-transparent via-white/40 to-transparent animate-[shimmer_2s_infinite]" />
                          )}
                        </div>
                      </div>

                      <div className="mt-5 grid grid-cols-2 overflow-hidden rounded-2xl border border-white/[0.06] bg-black/30 sm:grid-cols-4">
                        <DownloadStat
                          icon={Zap}
                          label="Speed"
                          value={progress.progress?.speed || '-'}
                          helper="Current"
                        />
                        <DownloadStat
                          icon={HardDriveDownload}
                          label="Downloaded"
                          value={formatBytes(progress.progress?.downloaded_bytes)}
                          helper="Transferred"
                        />
                        <DownloadStat
                          icon={Gauge}
                          label="Total size"
                          value={formatBytes(progress.progress?.total_bytes)}
                          helper="File size"
                        />
                        <DownloadStat
                          icon={Clock3}
                          label="ETA"
                          value={progress.progress?.eta || '-'}
                          helper="Remaining"
                        />
                      </div>
                    </>
                  )}

                  {isThumbJob && (
                    <div className="mt-7">
                      <div className="flex items-center justify-between text-xs text-zinc-500">
                        <span>Preparing thumbnail</span>
                        <span>{progress.progress?.percent || 'Downloading'}</span>
                      </div>

                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.05]">
                        <div className="h-full w-full animate-pulse rounded-full bg-gradient-to-r from-violet-500 via-fuchsia-500 to-blue-400" />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Cancelled */}
          {progress?.status === 'cancelled' && (
            <StatusCard
              type="cancelled"
              title="Download cancelled"
              label="Cancelled"
              description="The download was stopped and partial files were removed."
              buttonLabel="Try another video"
              onAction={resetAll}
            />
          )}

          {/* Failed */}
          {progress?.status === 'failed' && (
            <StatusCard
              type="failed"
              title={isThumbJob ? 'Thumbnail download failed' : 'Download failed'}
              label="Error"
              description={
                progress.error ||
                error ||
                'Something went wrong while processing the download.'
              }
              buttonLabel="Try again"
              onAction={resetAll}
            />
          )}

          {/* Success */}
          {downloadUrl && (
            <section className="p-4 sm:p-6 lg:p-7">
              <div className="relative mx-auto max-w-3xl overflow-hidden rounded-[24px] border border-emerald-400/20 bg-emerald-400/[0.03] p-7 text-center shadow-[0_30px_80px_-20px_rgba(0,0,0,.5)] sm:p-10">
                <div className="pointer-events-none absolute left-1/2 top-0 h-48 w-80 -translate-x-1/2 rounded-full bg-emerald-400/10 blur-3xl" />
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/30 to-transparent" />

                <div className="relative">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-400/10 ring-1 ring-emerald-400/20">
                    <CheckCircle2 className="h-8 w-8 text-emerald-300" />
                  </div>

                  <p className="mt-6 text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-300">
                    Ready
                  </p>

                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-white">
                    {isThumbJob ? 'Thumbnail saved' : 'Download started'}
                  </h3>

                  <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-zinc-400">
                    Your browser is saving the file. If automatic download was blocked,
                    use the button below.
                  </p>

                  <p className="mx-auto mt-4 max-w-xl truncate text-xs text-zinc-600">
                    {isThumbJob
                      ? 'High-resolution thumbnail'
                      : `${info?.title || 'Video'} • ${selectedFormatLabel}`}
                  </p>

                  <div className="mt-7 flex flex-col justify-center gap-2 sm:flex-row">
                    <a
                      href={downloadUrl}
                      download
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-bold text-black transition hover:bg-zinc-200 active:scale-[0.98]"
                    >
                      <Download className="h-4 w-4" />
                      Download again
                    </a>

                    <button
                      onClick={resetAll}
                      className="rounded-xl border border-white/[0.08] px-6 py-3 text-sm font-bold text-zinc-300 transition hover:bg-white/[0.04] hover:text-white active:scale-[0.98]"
                    >
                      Download another
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Empty state */}
          {!info && !progress && !downloadUrl && (
            <section className="p-5 sm:p-7 lg:p-8">
              <div className="grid gap-3 sm:grid-cols-3">
                <FeatureCard
                  icon={Zap}
                  title="Fast processing"
                  description="Analyze a link, choose a format and start downloading."
                />
                <FeatureCard
                  icon={Video}
                  title="Quality control"
                  description="Best quality, available resolutions, MP3 and 3GP."
                />
                <FeatureCard
                  icon={ImageIcon}
                  title="Thumbnail tools"
                  description="Preview all available thumbnail sizes and save them."
                />
              </div>

              <div className="mt-5 flex items-center justify-center gap-2 rounded-2xl border border-white/[0.05] bg-white/[0.015] px-4 py-3 text-center text-[11px] text-zinc-600">
                <Info className="h-3.5 w-3.5" />
                Paste a YouTube URL above to inspect the video and unlock download options.
              </div>
            </section>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="relative border-t border-white/[0.05] bg-black/20">
        <div className="mx-auto flex max-w-[1440px] flex-col items-center justify-between gap-3 px-5 py-7 text-center sm:flex-row sm:px-8 sm:text-left lg:px-10">
          <div>
            <p className="text-[11px] font-medium text-zinc-500">
              Educational use only. Respect copyright and YouTube Terms of Service.
            </p>
            <p className="mt-1 text-[10px] text-zinc-700">
              Powered by yt-dlp & FFmpeg • Premium downloader interface
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full border border-white/[0.06] px-3 py-1.5 text-[10px] text-zinc-600">
              <Wifi className="h-3 w-3" />
              Ready
            </span>
            <span className="rounded-full border border-white/[0.06] px-3 py-1.5 text-[10px] text-zinc-600">
              v2.0 UI
            </span>
          </div>
        </div>
      </footer>

      {/* History modal */}
      {showHistory && (
        <Modal title="Download history" onClose={() => setShowHistory(false)}>
          {history.length === 0 ? (
            <div className="py-10 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.03]">
                <History className="h-6 w-6 text-zinc-600" />
              </div>
              <h3 className="mt-4 text-base font-bold text-white">No downloads yet</h3>
              <p className="mt-1 text-xs leading-5 text-zinc-600">
                Completed downloads will appear here on this device.
              </p>
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between">
                <p className="text-xs text-zinc-500">
                  Stored locally in your browser.
                </p>
                <button
                  onClick={clearHistory}
                  className="text-xs font-bold text-red-300 transition hover:text-red-200"
                >
                  Clear history
                </button>
              </div>

              <div className="space-y-2">
                {history.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 transition hover:border-white/[0.1] hover:bg-white/[0.035]"
                  >
                    {item.thumbnail ? (
                      <img
                        src={item.thumbnail}
                        alt=""
                        className="h-14 w-24 shrink-0 rounded-xl object-cover"
                      />
                    ) : (
                      <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-xl bg-white/[0.03]">
                        <Video className="h-5 w-5 text-zinc-600" />
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-white">
                        {item.title}
                      </p>
                      <p className="mt-1 text-[10px] text-zinc-600">
                        {item.format} •{' '}
                        {new Date(item.timestamp).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Modal>
      )}

      {/* Settings modal */}
      {showSettings && (
        <Modal title="Settings" onClose={() => setShowSettings(false)}>
          <div className="space-y-3">
            <SettingRow
              title="Automatic download"
              description="Start the browser file save when a job completes."
              enabled={settings.autoDownload}
              onToggle={() =>
                setSettings((s) => ({
                  ...s,
                  autoDownload: !s.autoDownload,
                }))
              }
            />

            <SettingRow
              title="Compact interface"
              description="Reserved for future density controls."
              enabled={settings.compactMode}
              onToggle={() =>
                setSettings((s) => ({
                  ...s,
                  compactMode: !s.compactMode,
                }))
              }
            />

            <div className="mt-5 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-400" />
                <div>
                  <p className="text-xs font-bold text-white">Local preferences</p>
                  <p className="mt-1 text-[11px] leading-5 text-zinc-600">
                    History and these UI preferences are kept in your browser.
                    The downloader API remains responsible for processing jobs.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Modal>
      )}

      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 8px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }
        html { scroll-behavior: smooth; }
      `}</style>
    </div>
  );
}

function DownloadStat({ icon: Icon, label, value, helper }) {
  return (
    <div className="border-b border-white/[0.06] p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:p-5 sm:last:border-r-0">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-zinc-600">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <p className="mt-2 text-lg font-bold tabular-nums text-white sm:text-xl">
        {value}
      </p>
      <p className="mt-1 text-[10px] text-zinc-700">{helper}</p>
    </div>
  );
}

function FeatureCard({ icon: Icon, title, description }) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5 transition hover:border-violet-400/20 hover:bg-white/[0.03]">
      <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-violet-500/0 blur-2xl transition group-hover:bg-violet-500/10" />
      <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-violet-400/[0.08] text-violet-300 ring-1 ring-violet-400/10 transition group-hover:scale-105">
        <Icon className="h-[18px] w-[18px]" />
      </div>
      <h3 className="relative mt-4 text-sm font-bold text-zinc-200">{title}</h3>
      <p className="relative mt-1.5 text-xs leading-5 text-zinc-600">{description}</p>
    </div>
  );
}

function StatusCard({
  type,
  title,
  label,
  description,
  buttonLabel,
  onAction,
}) {
  const failed = type === 'failed';
  const Icon = failed ? AlertCircle : XCircle;

  return (
    <section className="p-4 sm:p-6 lg:p-7">
      <div
        className={`relative mx-auto max-w-2xl overflow-hidden rounded-[24px] p-8 text-center shadow-[0_30px_80px_-20px_rgba(0,0,0,.5)] sm:p-10 ${
          failed
            ? 'border border-red-400/15 bg-red-400/[0.03]'
            : 'border border-orange-400/15 bg-orange-400/[0.03]'
        }`}
      >
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent ${
            failed ? 'via-red-400/30' : 'via-orange-400/30'
          } to-transparent`}
        />
        <div
          className={`mx-auto flex h-16 w-16 items-center justify-center rounded-2xl ring-1 ${
            failed
              ? 'bg-red-400/10 text-red-300 ring-red-400/20'
              : 'bg-orange-400/10 text-orange-300 ring-orange-400/20'
          }`}
        >
          <Icon className="h-8 w-8" />
        </div>

        <p
          className={`mt-6 text-[10px] font-bold uppercase tracking-[0.2em] ${
            failed ? 'text-red-300' : 'text-orange-300'
          }`}
        >
          {label}
        </p>

        <h3 className="mt-2 text-2xl font-bold tracking-tight text-white">{title}</h3>

        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-zinc-400">
          {description}
        </p>

        <button
          onClick={onAction}
          className="mt-7 inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-bold text-black transition hover:bg-zinc-200 active:scale-[0.98]"
        >
          <Search className="h-4 w-4" />
          {buttonLabel}
        </button>
      </div>
    </section>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-3 backdrop-blur-md sm:items-center sm:p-6">
      <div className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-white/[0.09] bg-[#0a0a0d] shadow-[0_40px_120px_-20px_rgba(0,0,0,.8)]">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4 sm:px-6">
          <h2 className="text-[15px] font-bold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.05] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto p-5 sm:p-6">
          {children}
        </div>
      </div>
    </div>
  );
}

function SettingRow({ title, description, enabled, onToggle }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-white">{title}</p>
        <p className="mt-1 text-[11px] leading-5 text-zinc-600">{description}</p>
      </div>

      <button
        onClick={onToggle}
        aria-pressed={enabled}
        className={`relative h-6 w-11 shrink-0 rounded-full p-0.5 transition ${
          enabled ? 'bg-violet-500' : 'bg-white/[0.1]'
        }`}
      >
        <span
          className={`block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ${
            enabled ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}