import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  Bell,
  Camera,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Eye,
  Fingerprint,
  LockKeyhole,
  Menu,
  Mic,
  Moon,
  Play,
  ScanFace,
  Shield,
  ShieldCheck,
  Sparkles,
  Sun,
  Video,
  X,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useAuth } from '@/hooks/useAuth';

const featureCards = [
  {
    icon: Video,
    title: 'Live camera monitoring',
    description: 'View connected indoor camera feeds and keep important scenes in sight.',
    accent: 'blue',
  },
  {
    icon: Mic,
    title: 'Speech signal analysis',
    description: 'Analyze CCTV audio for the emergency keywords enrolled in your system.',
    accent: 'indigo',
  },
  {
    icon: ScanFace,
    title: 'Context-aware vision',
    description: 'Combine visual detections and facial-expression evidence with accepted speech.',
    accent: 'cyan',
  },
  {
    icon: Bell,
    title: 'Safety alert validation',
    description: 'Use matching evidence to help determine when a safety alert should be raised.',
    accent: 'rose',
  },
  {
    icon: Activity,
    title: 'Event history',
    description: 'Review significant detection events and the available incident evidence.',
    accent: 'violet',
  },
  {
    icon: LockKeyhole,
    title: 'Connected monitoring workspace',
    description: 'Access cameras, monitoring tools, and account features from one dashboard.',
    accent: 'emerald',
  },
] as const;

const steps = [
  {
    number: '01',
    title: 'Connect a camera',
    description: 'Open the dashboard and configure an indoor camera stream.',
    icon: Camera,
  },
  {
    number: '02',
    title: 'Analyze signals',
    description: 'The monitoring pipeline evaluates visual information and incoming audio.',
    icon: Cpu,
  },
  {
    number: '03',
    title: 'Review the evidence',
    description: 'Inspect recognized events, validation results, and camera alerts.',
    icon: ShieldCheck,
  },
] as const;

const slideUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

function CameraPreviewScene() {
  return (
    <svg
      className="block h-full w-full"
      viewBox="0 0 640 400"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="Illustrative indoor camera view with person detection overlays"
    >
      <defs>
        <linearGradient id="msds-preview-wall" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#afcbdc" />
          <stop offset="0.55" stopColor="#e3ecf4" />
          <stop offset="1" stopColor="#7d9caf" />
        </linearGradient>
        <linearGradient id="msds-preview-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b3c7d2" />
          <stop offset="1" stopColor="#526e83" />
        </linearGradient>
        <linearGradient id="msds-preview-glass" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#45748d" stopOpacity=".85" />
          <stop offset=".5" stopColor="#cde2eb" stopOpacity=".7" />
          <stop offset="1" stopColor="#30566e" stopOpacity=".85" />
        </linearGradient>
        <linearGradient id="msds-preview-vignette" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#06203e" stopOpacity=".04" />
          <stop offset="1" stopColor="#061427" stopOpacity=".35" />
        </linearGradient>
      </defs>
      <rect width="640" height="400" fill="url(#msds-preview-wall)" />
      <polygon points="0,0 640,0 382,155 258,155" fill="#eaf1f5" />
      <polygon points="0,0 258,155 258,296 0,400" fill="#b8cfdd" />
      <polygon points="640,0 382,155 382,296 640,400" fill="#8eacbe" />
      <polygon points="0,400 258,296 382,296 640,400" fill="url(#msds-preview-floor)" />
      <rect x="258" y="155" width="124" height="143" fill="#6a8ba0" />
      <rect x="281" y="174" width="78" height="122" fill="#86a6b8" />
      <rect x="301" y="187" width="38" height="109" fill="#b8cbd4" />
      <g stroke="#d9e8ee" strokeWidth="3" opacity=".65">
        <path d="M0 63L260 183M0 163L260 225M640 63L382 183M640 163L382 225" />
        <path d="M143 0L282 155M496 0L357 155" />
      </g>
      <g fill="url(#msds-preview-glass)" stroke="#7ba3b8" strokeWidth="3">
        <polygon points="24,85 206,153 206,261 24,335" />
        <polygon points="426,154 608,86 608,338 426,261" />
      </g>
      <g stroke="#a7c5d5" strokeWidth="3" opacity=".8">
        <path d="M94 113V304M161 138V278M478 137V282M547 110V310" />
      </g>
      <g fill="#eef4f7" opacity=".7">
        <rect x="285" y="160" width="20" height="5" rx="2" />
        <rect x="334" y="160" width="20" height="5" rx="2" />
        <path d="M0 398L258 296M640 398L382 296" />
      </g>
      <g transform="translate(125 188)">
        <ellipse cx="0" cy="22" rx="16" ry="20" fill="#30495c" />
        <path d="M-20 51Q0 36 20 51L24 112L12 117L8 76L5 163L-6 163L-11 93L-13 163L-24 163L-20 77L-27 112L-37 108Z" fill="#1c354b" />
      </g>
      <g transform="translate(320 157)">
        <ellipse cx="0" cy="24" rx="20" ry="24" fill="#354458" />
        <path d="M-25 56Q0 42 25 56L30 140L20 145L14 88L13 208L-1 208L-9 122L-17 208L-31 208L-22 87L-31 142L-43 138Z" fill="#1b2b42" />
        <path d="M-23 58Q0 46 23 58L20 100L-19 100Z" fill="#40536a" />
      </g>
      <g transform="translate(514 195)">
        <ellipse cx="0" cy="20" rx="15" ry="19" fill="#344655" />
        <path d="M-20 46Q0 34 20 46L25 100L14 105L10 73L8 150L-3 150L-9 91L-13 150L-24 150L-19 72L-27 102L-36 98Z" fill="#2b4356" />
      </g>
      <rect width="640" height="400" fill="url(#msds-preview-vignette)" />
      <g fill="none" strokeWidth="3">
        <rect x="77" y="198" width="96" height="158" rx="3" stroke="#34e1a0" />
        <rect x="267" y="175" width="108" height="197" rx="3" stroke="#ff6178" />
        <rect x="464" y="207" width="96" height="148" rx="3" stroke="#34e1a0" />
      </g>
      <g fontFamily="Arial, sans-serif" fontSize="15" fontWeight="700" textAnchor="middle">
        <rect x="77" y="175" width="77" height="24" rx="5" fill="#11a879" />
        <text x="115" y="192" fill="white">Person</text>
        <rect x="267" y="152" width="81" height="24" rx="5" fill="#ec3f59" />
        <text x="307" y="169" fill="white">Person</text>
        <rect x="464" y="184" width="77" height="24" rx="5" fill="#11a879" />
        <text x="502" y="201" fill="white">Person</text>
      </g>
      <rect x="16" y="15" width="81" height="29" rx="8" fill="#e93b50" />
      <circle cx="33" cy="29" r="5" fill="white" />
      <text x="46" y="34" fill="white" fontSize="16" fontWeight="700" fontFamily="Arial, sans-serif">DEMO</text>
    </svg>
  );
}

function DashboardPreview() {
  return (
    <div className="relative mx-auto w-full max-w-[760px] lg:translate-x-2">
      <div className="pointer-events-none absolute -inset-6 rounded-[3rem] bg-blue-400/15 blur-3xl dark:bg-blue-500/10" />
      <div className="relative overflow-hidden rounded-[1.75rem] border border-blue-100/90 bg-white/95 p-3 shadow-[0_35px_85px_-24px_rgba(25,78,157,0.3)] ring-1 ring-white/80 backdrop-blur-xl sm:p-4 dark:border-slate-700 dark:bg-slate-900/95 dark:ring-slate-700">
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-slate-100 px-2 pb-3 dark:border-slate-700">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-lg shadow-blue-500/20">
              <Eye className="h-5 w-5" />
            </div>
            <span className="truncate font-extrabold tracking-tight text-slate-900 dark:text-white">MSDSSystem</span>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-[0.75rem] font-bold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            <span className="h-2 w-2 rounded-full bg-blue-500" />
            Concept preview
          </span>
        </div>
        <div className="flex gap-3">
          <aside aria-label="Preview navigation, not interactive" className="hidden w-[104px] shrink-0 flex-col gap-1.5 pt-1 sm:flex">
            <div className="flex items-center gap-2 rounded-xl bg-blue-600 px-2.5 py-3 text-[0.78rem] font-bold text-white"><Activity className="h-4 w-4" /> Overview</div>
            <div className="flex items-center gap-2 rounded-xl px-2.5 py-3 text-[0.78rem] font-medium text-slate-600 dark:text-slate-300"><Video className="h-4 w-4" /> Live view</div>
            <div className="flex items-center gap-2 rounded-xl px-2.5 py-3 text-[0.78rem] font-medium text-slate-600 dark:text-slate-300"><Bell className="h-4 w-4" /> Alerts</div>
            <div className="flex items-center gap-2 rounded-xl px-2.5 py-3 text-[0.78rem] font-medium text-slate-600 dark:text-slate-300"><Cpu className="h-4 w-4" /> Analysis</div>
          </aside>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between pb-2">
              <span className="font-bold text-slate-800 dark:text-slate-100">Camera monitoring</span>
              <span className="flex items-center gap-1 text-[0.75rem] font-semibold text-slate-500 dark:text-slate-400"><Camera className="h-3.5 w-3.5" /> Indoor scene</span>
            </div>
            <div className="relative aspect-[16/10] overflow-hidden rounded-xl bg-slate-800 shadow-inner">
              <CameraPreviewScene />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div className="rounded-xl border border-blue-100 bg-blue-50 p-2.5 dark:border-blue-900/50 dark:bg-blue-950/40">
                <UsersIcon />
                <div className="mt-1 font-bold text-slate-800 dark:text-slate-100">Vision</div>
                <div className="text-[0.72rem] text-slate-500 dark:text-slate-400">Object analysis</div>
              </div>
              <div className="rounded-xl border border-rose-100 bg-rose-50 p-2.5 dark:border-rose-900/50 dark:bg-rose-950/30">
                <Bell className="h-4 w-4 text-rose-500" />
                <div className="mt-1 font-bold text-slate-800 dark:text-slate-100">Alerts</div>
                <div className="text-[0.72rem] text-slate-500 dark:text-slate-400">Evidence checks</div>
              </div>
              <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-2.5 dark:border-emerald-900/50 dark:bg-emerald-950/30">
                <Mic className="h-4 w-4 text-emerald-600" />
                <div className="mt-1 font-bold text-slate-800 dark:text-slate-100">Audio</div>
                <div className="text-[0.72rem] text-slate-500 dark:text-slate-400">Keyword signals</div>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-slate-100 px-1 pt-3 text-[0.75rem] text-slate-500 dark:border-slate-700 dark:text-slate-400">
          <span>Illustrative interface — not a live camera feed</span>
          <span className="flex items-center gap-1 font-semibold text-blue-600 dark:text-blue-400"><Sparkles className="h-3.5 w-3.5" /> Audio + vision</span>
        </div>
      </div>
      <div className="relative -mt-4 ml-4 flex max-w-[260px] items-center gap-3 rounded-2xl border border-white/90 bg-white/95 px-4 py-3 shadow-[0_18px_40px_-16px_rgba(30,75,140,0.34)] backdrop-blur-xl dark:border-slate-700 dark:bg-slate-800/95 sm:-mt-6 sm:ml-7">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400"><Bell className="h-5 w-5" /></div>
        <div>
          <div className="font-bold text-slate-900 dark:text-white">Safety alerts</div>
          <div className="text-[0.79rem] text-slate-500 dark:text-slate-400">Context-aware validation</div>
        </div>
      </div>
    </div>
  );
}

function UsersIcon() {
  return <ScanFace className="h-4 w-4 text-blue-600" />;
}

export default function Landing() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('safewatch-dark-mode');
    if (saved === 'true') return true;
    if (saved === 'false') return false;
    return document.documentElement.classList.contains('dark');
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('safewatch-dark-mode', String(darkMode));
  }, [darkMode]);

  const startPath = user ? '/dashboard' : '/auth';
  const goTo = (id: string) => {
    setMenuOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f8fbff] text-slate-900 transition-colors duration-300 dark:bg-[#091326] dark:text-white">
      <header className="sticky top-0 z-50 border-b border-blue-100/70 bg-white/90 backdrop-blur-xl dark:border-slate-800 dark:bg-[#0a1428]/90">
        <div className="mx-auto flex h-[78px] max-w-[1480px] items-center justify-between gap-4 px-5 sm:px-8 xl:px-14">
          <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="flex shrink-0 items-center gap-3 rounded-xl text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500" aria-label="MSDSSystem, back to top">
            <span className="flex h-12 w-12 items-center justify-center rounded-[1rem] bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-lg shadow-blue-500/20">
              <Eye className="h-7 w-7" strokeWidth={2.5} />
            </span>
            <span className="text-[1.3rem] font-black tracking-[-0.04em] text-slate-950 dark:text-white">MSDS<span className="text-blue-600 dark:text-blue-400">System</span></span>
          </button>

          <nav className="hidden items-center gap-1 lg:flex" aria-label="Main navigation">
            <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="rounded-xl bg-blue-50 px-4 py-3 font-bold text-blue-700 transition-colors hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300">Home</button>
            <button onClick={() => goTo('features')} className="rounded-xl px-4 py-3 font-semibold text-slate-600 hover:bg-slate-100 hover:text-blue-700 dark:text-slate-300 dark:hover:bg-slate-800">Features</button>
            <button onClick={() => goTo('how-it-works')} className="rounded-xl px-4 py-3 font-semibold text-slate-600 hover:bg-slate-100 hover:text-blue-700 dark:text-slate-300 dark:hover:bg-slate-800">How It Works</button>
            <button onClick={() => goTo('about')} className="rounded-xl px-4 py-3 font-semibold text-slate-600 hover:bg-slate-100 hover:text-blue-700 dark:text-slate-300 dark:hover:bg-slate-800">About</button>
          </nav>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => setDarkMode(prev => !prev)}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-800 transition-colors hover:bg-blue-100 dark:bg-slate-800 dark:text-blue-100 dark:hover:bg-slate-700"
            >
              {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            {!loading && (
              <>
                {!user && (
                  <button onClick={() => navigate('/auth')} className="hidden rounded-xl border border-slate-200 bg-white px-5 py-3 font-bold text-slate-800 shadow-sm transition-colors hover:bg-slate-50 sm:inline-flex dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:hover:bg-slate-800">
                    Sign In
                  </button>
                )}
                <button onClick={() => navigate(startPath)} className="hidden items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 font-bold text-white shadow-lg shadow-blue-600/20 transition-transform hover:-translate-y-0.5 hover:bg-blue-700 sm:inline-flex">
                  {user ? 'Dashboard' : 'Get Started'}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </>
            )}
            <button type="button" onClick={() => setMenuOpen(prev => !prev)} aria-expanded={menuOpen} aria-label="Toggle navigation menu" className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white lg:hidden dark:border-slate-700 dark:bg-slate-900">
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav aria-label="Mobile navigation" className="border-t border-blue-100 bg-white px-5 py-4 dark:border-slate-700 dark:bg-slate-900 lg:hidden">
            <div className="mx-auto flex max-w-[1480px] flex-col gap-1">
              <button onClick={() => { setMenuOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="rounded-xl px-4 py-3 text-left font-semibold hover:bg-blue-50 dark:hover:bg-slate-800">Home</button>
              <button onClick={() => goTo('features')} className="rounded-xl px-4 py-3 text-left font-semibold hover:bg-blue-50 dark:hover:bg-slate-800">Features</button>
              <button onClick={() => goTo('how-it-works')} className="rounded-xl px-4 py-3 text-left font-semibold hover:bg-blue-50 dark:hover:bg-slate-800">How It Works</button>
              <button onClick={() => goTo('about')} className="rounded-xl px-4 py-3 text-left font-semibold hover:bg-blue-50 dark:hover:bg-slate-800">About</button>
              {!loading && <button onClick={() => navigate(startPath)} className="mt-2 rounded-xl bg-blue-600 px-4 py-3 text-left font-bold text-white sm:hidden">{user ? 'Open Dashboard' : 'Get Started'}</button>}
            </div>
          </nav>
        )}
      </header>

      <main>
        <section className="relative isolate overflow-hidden">
          <div className="pointer-events-none absolute -right-48 -top-64 h-[700px] w-[700px] rounded-full bg-blue-200/60 blur-[90px] dark:bg-blue-800/20" />
          <div className="pointer-events-none absolute -bottom-72 left-1/3 h-[620px] w-[860px] rounded-full bg-cyan-100/70 blur-[110px] dark:bg-indigo-900/20" />
          <div className="pointer-events-none absolute left-0 top-0 h-52 w-52 rounded-br-full bg-blue-100/60 dark:bg-blue-950/40" />
          <div className="pointer-events-none absolute right-[28%] top-12 hidden h-44 w-44 opacity-30 lg:block" style={{ backgroundImage: 'radial-gradient(#60a5fa 1.8px, transparent 1.8px)', backgroundSize: '19px 19px' }} />
          <div className="relative mx-auto grid min-h-[680px] max-w-[1480px] items-center gap-12 px-5 py-16 sm:px-8 lg:grid-cols-2 lg:gap-8 lg:py-20 xl:gap-12 xl:px-14">
            <motion.div initial="hidden" animate="visible" transition={{ staggerChildren: 0.1 }} className="relative z-10">
              <motion.div variants={slideUp} transition={{ duration: 0.5 }} className="mb-8 inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-100/80 px-4 py-2 font-bold text-blue-700 shadow-sm dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300">
                <Shield className="h-4 w-4" />
                Secure <span className="text-blue-400">•</span> Real-Time <span className="text-blue-400">•</span> Intelligent
              </motion.div>
              <motion.h1 variants={slideUp} transition={{ duration: 0.6 }} className="max-w-[740px] text-[clamp(2.7rem,4.8vw,5.4rem)] font-black leading-[1.07] tracking-[-0.06em] text-slate-950 dark:text-white">
                Multimodal Saliency <span className="block bg-gradient-to-r from-[#0765eb] via-[#1769ef] to-[#438fff] bg-clip-text text-transparent">Detection System</span>
              </motion.h1>
              <motion.p variants={slideUp} transition={{ duration: 0.6 }} className="mt-7 max-w-[600px] text-[1.15rem] font-medium leading-relaxed text-slate-600 dark:text-slate-300 sm:text-[1.25rem]">
                Live camera monitoring and safety alerts powered by multimodal analysis of speech signals and indoor visual events.
              </motion.p>
              <motion.div variants={slideUp} transition={{ duration: 0.6 }} className="mt-9 flex flex-wrap items-center gap-4">
                <button onClick={() => navigate(startPath)} className="group inline-flex min-h-[60px] items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-blue-600 to-[#0969f4] px-8 py-4 text-[1.1rem] font-extrabold text-white shadow-[0_18px_35px_-12px_rgba(37,99,235,0.55)] transition-transform hover:-translate-y-1 hover:shadow-[0_24px_40px_-12px_rgba(37,99,235,0.55)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600">
                  {user ? 'Open Dashboard' : 'Get Started Free'}
                  <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                </button>
                <button onClick={() => goTo('how-it-works')} className="inline-flex min-h-[60px] items-center gap-2 rounded-2xl border border-blue-100 bg-white/80 px-6 py-4 font-bold text-slate-700 shadow-sm transition-colors hover:border-blue-300 hover:bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-blue-500">
                  <Play className="h-4 w-4 fill-current text-blue-600" />
                  How it works
                </button>
              </motion.div>
              <motion.div variants={slideUp} transition={{ duration: 0.7 }} className="mt-12 grid max-w-[650px] grid-cols-1 gap-4 sm:grid-cols-3">
                {[
                  { icon: Video, label: 'Live camera monitoring' },
                  { icon: Bell, label: 'Safety alert validation' },
                  { icon: Cpu, label: 'Audio-visual analysis' },
                ].map(item => (
                  <div key={item.label} className="flex items-center gap-3">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/85 text-blue-600 shadow-[0_6px_18px_-10px_rgba(28,88,175,0.4)] ring-1 ring-blue-100 dark:bg-slate-800 dark:text-blue-400 dark:ring-slate-700">
                      <item.icon className="h-5 w-5" />
                    </span>
                    <span className="text-[0.9rem] font-bold leading-snug text-slate-800 dark:text-slate-200">{item.label}</span>
                  </div>
                ))}
              </motion.div>
            </motion.div>
            <motion.div initial={{ opacity: 0, x: 30, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ duration: 0.75, delay: 0.15 }} className="relative z-10">
              <DashboardPreview />
            </motion.div>
          </div>
        </section>

        <section className="relative border-y border-blue-100/70 bg-white/85 py-6 dark:border-slate-800 dark:bg-[#0c1830]" aria-label="Monitoring capabilities">
          <div className="mx-auto flex max-w-[1480px] flex-wrap items-center justify-center gap-x-12 gap-y-5 px-5 text-slate-600 dark:text-slate-300 sm:px-8 xl:px-14">
            <span className="inline-flex items-center gap-2 font-semibold"><CheckCircle2 className="h-5 w-5 text-emerald-500" /> CCTV-connected monitoring</span>
            <span className="inline-flex items-center gap-2 font-semibold"><CheckCircle2 className="h-5 w-5 text-emerald-500" /> Audio and vision signals</span>
            <span className="inline-flex items-center gap-2 font-semibold"><CheckCircle2 className="h-5 w-5 text-emerald-500" /> Evidence-based alert workflow</span>
          </div>
        </section>

        <section id="features" className="scroll-mt-24 px-5 py-24 sm:px-8 xl:px-14">
          <div className="mx-auto max-w-[1280px]">
            <div className="mx-auto mb-14 max-w-[750px] text-center">
              <span className="inline-flex items-center gap-2 rounded-full bg-blue-100 px-4 py-2 font-bold text-blue-700 dark:bg-blue-950 dark:text-blue-300"><Sparkles className="h-4 w-4" /> CORE CAPABILITIES</span>
              <h2 className="mt-6 text-[clamp(2rem,3.5vw,3.5rem)] font-black tracking-tight text-slate-950 dark:text-white">Built for <span className="text-blue-600 dark:text-blue-400">smarter awareness</span></h2>
              <p className="mt-4 text-[1.08rem] font-medium leading-relaxed text-slate-600 dark:text-slate-300">A focused monitoring workspace bringing indoor video, speech analysis, and event review together.</p>
            </div>
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {featureCards.map((feature, i) => (
                <motion.article key={feature.title} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.15 }} transition={{ duration: 0.4, delay: i * 0.05 }} className="group rounded-[1.5rem] border border-blue-100 bg-white p-7 shadow-[0_8px_35px_-19px_rgba(20,70,140,0.22)] transition-all hover:-translate-y-1 hover:border-blue-200 hover:shadow-[0_18px_40px_-16px_rgba(30,90,170,0.24)] dark:border-slate-700 dark:bg-slate-900">
                  <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-50 to-blue-100 text-blue-600 ring-1 ring-blue-100 dark:from-blue-950 dark:to-indigo-950 dark:text-blue-400 dark:ring-blue-900"><feature.icon className="h-6 w-6" /></div>
                  <h3 className="text-[1.2rem] font-extrabold text-slate-900 dark:text-white">{feature.title}</h3>
                  <p className="mt-3 font-medium leading-relaxed text-slate-600 dark:text-slate-300">{feature.description}</p>
                  <div className="mt-6 flex items-center gap-2 font-bold text-blue-600 dark:text-blue-400"><span>MSDS capability</span><ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-1" /></div>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-24 border-y border-blue-100 bg-gradient-to-b from-[#f0f6ff] to-[#f8fbff] px-5 py-24 dark:border-slate-800 dark:from-[#0d1d3b] dark:to-[#0b162b] sm:px-8 xl:px-14">
          <div className="mx-auto max-w-[1280px]">
            <div className="mb-14 text-center">
              <span className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 font-bold text-blue-700 shadow-sm dark:bg-slate-800 dark:text-blue-300"><Fingerprint className="h-4 w-4" /> SIMPLE WORKFLOW</span>
              <h2 className="mt-5 text-[clamp(2rem,3.5vw,3.5rem)] font-black tracking-tight text-slate-950 dark:text-white">How MSDSSystem works</h2>
              <p className="mt-4 font-medium text-slate-600 dark:text-slate-300">From connected cameras to understandable event information.</p>
            </div>
            <div className="grid gap-5 md:grid-cols-3">
              {steps.map(step => (
                <article key={step.number} className="relative rounded-[1.5rem] border border-white bg-white/95 p-7 shadow-[0_10px_32px_-20px_rgba(30,80,160,0.3)] dark:border-slate-700 dark:bg-slate-900">
                  <div className="flex items-center justify-between">
                    <span className="text-[2.7rem] font-black tracking-tight text-blue-100 dark:text-blue-900">{step.number}</span>
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400"><step.icon className="h-6 w-6" /></span>
                  </div>
                  <h3 className="mt-5 text-[1.2rem] font-extrabold text-slate-900 dark:text-white">{step.title}</h3>
                  <p className="mt-3 font-medium leading-relaxed text-slate-600 dark:text-slate-300">{step.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="about" className="scroll-mt-24 px-5 py-24 sm:px-8 xl:px-14">
          <div className="mx-auto grid max-w-[1280px] items-center gap-12 lg:grid-cols-2">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full bg-blue-100 px-4 py-2 font-bold text-blue-700 dark:bg-blue-950 dark:text-blue-300"><ShieldCheck className="h-4 w-4" /> ABOUT THE SYSTEM</span>
              <h2 className="mt-6 text-[clamp(2rem,3.4vw,3.5rem)] font-black leading-tight tracking-tight text-slate-950 dark:text-white">Awareness through <span className="text-blue-600 dark:text-blue-400">combined signals.</span></h2>
              <p className="mt-5 max-w-[580px] font-medium leading-relaxed text-slate-600 dark:text-slate-300">MSDSSystem explores multimodal saliency detection for context-aware indoor awareness. It analyzes speech signals alongside camera-based visual information, then presents relevant monitoring events for review.</p>
              <button onClick={() => navigate(startPath)} className="group mt-7 inline-flex items-center gap-2 font-extrabold text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300">{user ? 'Go to dashboard' : 'Explore MSDSSystem'}<ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" /></button>
            </div>
            <div className="rounded-[2rem] border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-cyan-50 p-8 shadow-[0_20px_60px_-30px_rgba(42,90,165,0.32)] dark:border-slate-700 dark:from-[#12244a] dark:via-[#111d37] dark:to-[#0d2c3c] sm:p-10">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-600/25"><Eye className="h-9 w-9" /></div>
              <p className="mt-7 text-[1.6rem] font-black leading-snug tracking-tight text-slate-900 dark:text-white">Speech signals <span className="text-blue-600 dark:text-blue-400">+</span> object detection <span className="text-blue-600 dark:text-blue-400">+</span> contextual validation</p>
              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                {[
                  { icon: Mic, label: 'Audio input' },
                  { icon: Camera, label: 'Visual input' },
                  { icon: ShieldCheck, label: 'Event review' },
                ].map(item => (
                  <div key={item.label} className="flex items-center gap-2 rounded-xl border border-blue-100 bg-white/90 px-3 py-4 font-bold text-slate-700 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200"><item.icon className="h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />{item.label}</div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="px-5 pb-24 sm:px-8 xl:px-14">
          <div className="relative mx-auto max-w-[1280px] overflow-hidden rounded-[2rem] bg-gradient-to-r from-[#0a55cb] to-[#0879f5] px-7 py-12 text-center text-white shadow-[0_24px_65px_-30px_rgba(20,90,205,0.55)] sm:px-12 sm:py-16">
            <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full border-[35px] border-white/10" />
            <div className="pointer-events-none absolute -bottom-32 -left-16 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
            <h2 className="relative text-[clamp(2rem,3.4vw,3.5rem)] font-black tracking-tight">Ready to explore MSDSSystem?</h2>
            <p className="relative mx-auto mt-4 max-w-[610px] text-[1.08rem] font-medium text-blue-50">Open the monitoring workspace and see how speech and visual signals support indoor situational awareness.</p>
            <button onClick={() => navigate(startPath)} className="relative mt-8 inline-flex items-center gap-2 rounded-2xl bg-white px-8 py-4 text-[1.08rem] font-extrabold text-blue-700 shadow-xl transition-transform hover:-translate-y-1 hover:bg-blue-50">{user ? 'Open Dashboard' : 'Get Started Free'}<ArrowRight className="h-5 w-5" /></button>
          </div>
        </section>
      </main>

      <footer className="border-t border-blue-100 bg-white px-5 py-8 dark:border-slate-800 dark:bg-[#0a1428] sm:px-8 xl:px-14">
        <div className="mx-auto flex max-w-[1480px] flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
          <div className="flex items-center gap-2.5"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white"><Eye className="h-5 w-5" /></span><span className="font-extrabold text-slate-900 dark:text-white">MSDSSystem</span></div>
          <span className="font-medium text-slate-500 dark:text-slate-400">© {new Date().getFullYear()} Multimodal Saliency Detection System.</span>
        </div>
      </footer>
    </div>
  );
}
