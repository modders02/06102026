import { BrainCircuit, ChevronRight, Flame, ScanSearch, ShieldAlert, Sparkles, Volume2, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type AlgorithmId = 'vision' | 'fire' | 'face' | 'speech' | 'audio' | 'hybrid';

interface AlgorithmCard {
  id: AlgorithmId;
  name: string;
  file: string;
  summary: string;
  icon: typeof Workflow;
  hybrid?: boolean;
}

const CORE_ALGORITHMS: AlgorithmCard[] = [
  {
    id: 'vision',
    name: 'Visual Saliency + Object Detection',
    file: 'saliency.ts · detectionEngine.ts',
    summary: 'Object detection and visual saliency.',
    icon: ScanSearch,
  },
  {
    id: 'fire',
    name: 'Fire & Smoke Detection',
    file: 'fireDetection.ts',
    summary: 'Fire and smoke analysis.',
    icon: Flame,
  },
  {
    id: 'face',
    name: 'Facial Distress',
    file: 'useFaceDistress.ts',
    summary: 'Facial expression analysis.',
    icon: BrainCircuit,
  },
  {
    id: 'speech',
    name: 'CCTV Speech + Safety Words',
    file: 'camera.py · kws_engine.py · safetyLexicon.ts',
    summary: 'Speech and safety keyword recognition.',
    icon: ShieldAlert,
  },
  {
    id: 'audio',
    name: 'Sound Distress',
    file: 'useYamnet.ts',
    summary: 'Sound event classification.',
    icon: Volume2,
  },
];

const HYBRID_ALGORITHM: AlgorithmCard = {
  id: 'hybrid',
  name: 'MSDS Hybrid Algorithm',
  file: 'Index.tsx · useCameraPipeline.ts',
  summary: 'Multimodal detection and fusion.',
  icon: Workflow,
  hybrid: true,
};

interface ExpertModeProps {
  open: boolean;
  onClose: () => void;
  onSelectAlgorithm: (id: AlgorithmId) => void;
}

function AlgorithmButton({ algorithm, onSelect }: { algorithm: AlgorithmCard; onSelect: (id: AlgorithmId) => void }) {
  const Icon = algorithm.icon;
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => onSelect(algorithm.id)}
      className={`h-auto w-full justify-start whitespace-normal p-4 text-left ${algorithm.hybrid ? 'border-primary/60 bg-primary/10' : 'bg-card'}`}
    >
      <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${algorithm.hybrid ? 'bg-primary text-primary-foreground' : 'bg-secondary text-primary'}`}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-bold text-foreground">{algorithm.name}</span>
          {algorithm.hybrid && <span className="rounded bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">HYBRID</span>}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{algorithm.summary}</span>
        <code className="mt-2 block break-all text-xs text-primary">{algorithm.file}</code>
        <span className="mt-2 flex items-center gap-1 text-sm font-semibold text-primary">
          Show this in the system <ChevronRight className="h-4 w-4" />
        </span>
      </span>
    </Button>
  );
}

export default function ExpertMode({ open, onClose, onSelectAlgorithm }: ExpertModeProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/85 p-3 backdrop-blur-sm" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="expert-mode-title"
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-primary/40 bg-background shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border bg-card p-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Workflow className="h-6 w-6" />
            </span>
            <div>
              <h2 id="expert-mode-title" className="flex items-center gap-2 text-2xl font-bold text-foreground">
                Expert Mode <Sparkles className="h-5 w-5 text-primary" />
              </h2>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close Expert Mode">
            <span className="text-2xl leading-none">×</span>
          </Button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          <section aria-labelledby="core-algorithms-title">
            <div className="mb-3">
              <h3 id="core-algorithms-title" className="text-lg font-bold text-foreground">Our algorithms</h3>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {CORE_ALGORITHMS.map(algorithm => (
                <AlgorithmButton key={algorithm.id} algorithm={algorithm} onSelect={onSelectAlgorithm} />
              ))}
            </div>
          </section>

          <section aria-labelledby="hybrid-algorithm-title">
            <div className="mb-3">
              <h3 id="hybrid-algorithm-title" className="text-lg font-bold text-foreground">Our hybrid algorithm</h3>
            </div>
            <AlgorithmButton algorithm={HYBRID_ALGORITHM} onSelect={onSelectAlgorithm} />
          </section>
        </div>
      </section>
    </div>
  );
}
