import { cn } from '@/lib/cn';

export default function XAiBackdrop({ className }: { className?: string }) {
  return (
    <div className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)} aria-hidden>
      {/* base black with very subtle radial lift */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(900px 900px at 68% 42%, rgba(255,255,255,0.03) 0%, transparent 62%), radial-gradient(1200px 980px at 52% 58%, rgba(255,255,255,0.018) 0%, transparent 72%), linear-gradient(180deg, #050507 0%, #07070a 50%, #050507 100%)',
        }}
      />

      {/* giant embossed "X" (two diagonal strokes) */}
      <div
        className="absolute left-1/2 top-1/2"
        style={{
          width: 1200,
          height: 1200,
          transform: 'translate(-50%, -52%)',
          opacity: 0.85,
        }}
      >
        {/* stroke A */}
        <div
          className="absolute left-1/2 top-1/2"
          style={{
            width: 1320,
            height: 260,
            transform: 'translate(-50%, -50%) rotate(32deg)',
            borderRadius: 240,
            background:
              'linear-gradient(90deg, rgba(255,255,255,0.00) 0%, rgba(255,255,255,0.016) 18%, rgba(255,255,255,0.045) 50%, rgba(255,255,255,0.016) 82%, rgba(255,255,255,0.00) 100%)',
            boxShadow:
              '0 1px 0 rgba(255,255,255,0.035) inset, 0 -1px 0 rgba(0,0,0,0.55) inset, 0 30px 120px rgba(0,0,0,0.55)',
            filter: 'blur(0.2px)',
          }}
        />
        {/* stroke B */}
        <div
          className="absolute left-1/2 top-1/2"
          style={{
            width: 1320,
            height: 260,
            transform: 'translate(-50%, -50%) rotate(-32deg)',
            borderRadius: 240,
            background:
              'linear-gradient(90deg, rgba(255,255,255,0.00) 0%, rgba(255,255,255,0.014) 18%, rgba(255,255,255,0.040) 50%, rgba(255,255,255,0.014) 82%, rgba(255,255,255,0.00) 100%)',
            boxShadow:
              '0 1px 0 rgba(255,255,255,0.030) inset, 0 -1px 0 rgba(0,0,0,0.55) inset, 0 30px 120px rgba(0,0,0,0.55)',
            filter: 'blur(0.2px)',
          }}
        />

        {/* subtle inner highlight ridge */}
        <div
          className="absolute left-1/2 top-1/2"
          style={{
            width: 1180,
            height: 1180,
            transform: 'translate(-50%, -50%)',
            borderRadius: 9999,
            background:
              'radial-gradient(closest-side at 50% 50%, rgba(255,255,255,0.018) 0%, rgba(255,255,255,0.012) 36%, rgba(255,255,255,0.0) 62%)',
            opacity: 0.55,
          }}
        />
      </div>

      {/* tiny dust/noise (very low contrast) */}
      <div
        className="absolute inset-0"
        style={{
          opacity: 0.06,
          mixBlendMode: 'overlay',
          backgroundImage:
            'radial-gradient(circle at 18px 22px, rgba(255,255,255,0.10) 0 1px, transparent 2px), radial-gradient(circle at 72px 64px, rgba(255,255,255,0.08) 0 1px, transparent 2px), radial-gradient(circle at 46px 92px, rgba(255,255,255,0.06) 0 1px, transparent 2px)',
          backgroundSize: '140px 140px',
          backgroundRepeat: 'repeat',
          filter: 'blur(0.15px)',
        }}
      />

      {/* vignette to match xAI look */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(closest-side at 50% 50%, rgba(0,0,0,0) 0%, rgba(0,0,0,0.35) 78%, rgba(0,0,0,0.70) 100%)',
          opacity: 0.75,
        }}
      />
    </div>
  );
}



