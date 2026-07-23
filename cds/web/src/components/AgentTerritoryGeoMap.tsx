import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import {
  Check,
  Info,
  MoonStar,
  Palette,
  SunMedium,
  type LucideIcon,
} from 'lucide-react';

import type { AgentPageContextId } from '@/lib/agent-onboarding';

export interface AgentTerritoryMission {
  id: AgentPageContextId;
  label: string;
  description: string;
  icon: LucideIcon;
}

type MapLayout = 'wide' | 'compact';
type MapSkin = 'adaptive' | 'mist' | 'night';

interface TerritoryShape {
  path: string;
  marker: readonly [number, number];
  hue: number;
}

interface Props {
  continentName: string;
  missions: AgentTerritoryMission[];
  selectedMissionId: AgentPageContextId;
  singleRegion: boolean;
  sourceContextId?: AgentPageContextId;
  onMissionChange: (missionId: AgentPageContextId) => void;
}

const MAP_SKINS: Array<{
  id: MapSkin;
  label: string;
  icon: LucideIcon;
}> = [
  { id: 'adaptive', label: '跟随界面', icon: Palette },
  { id: 'mist', label: '雾蓝', icon: SunMedium },
  { id: 'night', label: '夜航', icon: MoonStar },
];

const WIDE_TERRITORIES: TerritoryShape[] = [
  {
    path: 'M305 226 L107 240 C92 225 88 202 102 184 C92 154 104 126 122 112 C132 108 143 106 156 110 C185 86 232 80 278 103 Z',
    marker: [190, 164],
    hue: 176,
  },
  {
    path: 'M278 103 C320 74 356 80 382 98 C414 76 458 79 480 108 C516 110 548 147 532 182 C541 191 545 202 545 214 L525 183 L305 226 Z',
    marker: [409, 151],
    hue: 199,
  },
  {
    path: 'M305 226 L215 335 C176 344 132 322 118 282 C92 270 80 235 107 240 Z',
    marker: [180, 276],
    hue: 216,
  },
  {
    path: 'M305 226 L525 183 C556 205 553 248 520 270 C510 305 463 327 420 315 Z',
    marker: [448, 257],
    hue: 232,
  },
  {
    path: 'M305 226 L420 315 C400 342 350 350 310 330 C284 352 236 355 215 335 Z',
    marker: [315, 306],
    hue: 257,
  },
];

const COMPACT_TERRITORIES: TerritoryShape[] = [
  {
    path: 'M258 236 L88 228 C77 248 75 277 91 298 C72 325 78 361 108 380 L188 420 L258 236 Z',
    marker: [145, 276],
    hue: 216,
  },
  {
    path: 'M258 236 L245 68 C214 56 174 60 152 92 C120 88 91 118 100 147 C78 165 70 200 88 228 Z',
    marker: [167, 150],
    hue: 176,
  },
  {
    path: 'M245 68 C286 50 323 62 342 91 C379 79 416 104 418 139 C446 158 451 198 438 225 L258 236 Z',
    marker: [343, 150],
    hue: 199,
  },
  {
    path: 'M258 236 L438 225 C453 250 447 282 426 302 C438 336 415 371 382 376 L340 415 Z',
    marker: [379, 286],
    hue: 232,
  },
  {
    path: 'M258 236 L340 415 C361 408 378 395 382 376 C350 425 300 431 258 410 C234 429 208 430 188 420 Z',
    marker: [270, 355],
    hue: 257,
  },
];

const WIDE_CONTINENT = 'M278 103 C320 74 356 80 382 98 C414 76 458 79 480 108 C516 110 548 147 532 182 C556 205 553 248 520 270 C510 305 463 327 420 315 C400 342 350 350 310 330 C284 352 236 355 215 335 C176 344 132 322 118 282 C92 270 80 235 107 240 C92 225 88 202 102 184 C92 154 104 126 122 112 C132 108 143 106 156 110 C185 86 232 80 278 103 Z';
const COMPACT_CONTINENT = 'M245 68 C286 50 323 62 342 91 C379 79 416 104 418 139 C446 158 451 198 438 225 C453 250 447 282 426 302 C438 336 415 371 382 376 C350 425 300 431 258 410 C234 429 208 430 188 420 C151 433 116 414 108 380 C78 361 72 325 91 298 C75 277 77 248 88 228 C70 200 78 165 100 147 C91 118 120 88 152 92 C174 60 214 56 245 68 Z';

function useMapLayout(): MapLayout {
  const [layout, setLayout] = useState<MapLayout>(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
      ? 'compact'
      : 'wide'
  ));

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)');
    const syncLayout = (): void => setLayout(media.matches ? 'compact' : 'wide');
    syncLayout();
    media.addEventListener('change', syncLayout);
    return () => media.removeEventListener('change', syncLayout);
  }, []);

  return layout;
}

function handleRegionKeyDown(
  event: KeyboardEvent<SVGGElement>,
  selectMission: () => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  selectMission();
}

export default function AgentTerritoryGeoMap({
  continentName,
  missions,
  selectedMissionId,
  singleRegion,
  sourceContextId,
  onMissionChange,
}: Props): JSX.Element {
  const layout = useMapLayout();
  const [skin, setSkin] = useState<MapSkin>('adaptive');
  const territories = layout === 'compact' ? COMPACT_TERRITORIES : WIDE_TERRITORIES;
  const viewBox = layout === 'compact' ? '0 0 520 480' : '0 0 650 420';
  const completeContinent = layout === 'compact' ? COMPACT_CONTINENT : WIDE_CONTINENT;

  return (
    <div
      className="cds-agent-world-stage"
      data-layout={layout}
      data-map-skin={skin}
      data-single-region={singleRegion ? 'true' : 'false'}
    >
      <div className="cds-agent-world-toolbar">
        <div className="cds-agent-world-identity">
          <span>虚构任务大陆</span>
          <strong>根据当前设备自动重排</strong>
        </div>
        <div className="cds-agent-map-skin-picker" role="group" aria-label="地图皮肤">
          {MAP_SKINS.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={skin === option.id}
                data-selected={skin === option.id ? 'true' : 'false'}
                onClick={() => setSkin(option.id)}
              >
                <Icon aria-hidden="true" />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="cds-agent-world-canvas">
        <div className="cds-agent-world-map-surface">
          <svg
            className="cds-agent-world-svg"
            viewBox={viewBox}
            role="group"
            aria-label={`${continentName}虚构任务大陆`}
          >
            <defs>
              <pattern id="agent-map-grid" width="26" height="26" patternUnits="userSpaceOnUse">
                <path d="M26 0H0V26" className="cds-agent-world-grid-line" />
              </pattern>
              <filter id="agent-map-selected-glow" x="-35%" y="-35%" width="170%" height="170%">
                <feGaussianBlur stdDeviation="2.6" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <rect className="cds-agent-world-grid" width="100%" height="100%" fill="url(#agent-map-grid)" />
            <path className="cds-agent-world-continent-shadow" d={completeContinent} aria-hidden="true" />

            {missions.map((mission, index) => {
              const shape = territories[index] || territories[0];
              const selected = mission.id === selectedMissionId;
              const path = missions.length === 1 ? completeContinent : shape.path;
              const marker = missions.length === 1
                ? (layout === 'compact' ? [258, 240] : [315, 220])
                : shape.marker;
              return (
                <g
                  key={mission.id}
                  role="button"
                  tabIndex={0}
                  className="cds-agent-world-region"
                  data-selected={selected ? 'true' : 'false'}
                  aria-pressed={selected}
                  aria-label={`${mission.label}，${mission.description}`}
                  onClick={() => onMissionChange(mission.id)}
                  onKeyDown={(event) => handleRegionKeyDown(
                    event,
                    () => onMissionChange(mission.id),
                  )}
                  style={{
                    '--region-order': index,
                    '--region-hue': shape.hue,
                  } as CSSProperties}
                >
                  <path className="cds-agent-world-region-fill" d={path} />
                  {selected && (
                    <circle
                      key={`${mission.id}-pulse`}
                      className="cds-agent-world-selected-pulse"
                      cx={marker[0]}
                      cy={marker[1]}
                      r="22"
                      aria-hidden="true"
                    />
                  )}
                  <g
                    className="cds-agent-world-territory-marker"
                    data-selected={selected ? 'true' : 'false'}
                    transform={`translate(${marker[0]} ${marker[1]})`}
                    aria-hidden="true"
                  >
                    <circle r="15" />
                    <text y="4">{index + 1}</text>
                  </g>
                </g>
              );
            })}
          </svg>

          <div className="cds-agent-world-map-source">
            <span>代码生成</span>
            <strong>{layout === 'compact' ? '紧凑大陆' : '宽屏大陆'}</strong>
          </div>
        </div>

        <div className="cds-agent-territory-legend" aria-label="Agent 任务入口目录">
          <div className="cds-agent-territory-legend-heading">
            <span>可交给 Agent 的任务</span>
            <strong>{missions.length} 类入口</strong>
          </div>
          <div className="cds-agent-territory-options">
            {missions.map((mission, index) => {
              const Icon = mission.icon;
              const selected = mission.id === selectedMissionId;
              const fromCurrentPage = sourceContextId === mission.id;
              return (
                <button
                  key={mission.id}
                  type="button"
                  className="cds-agent-territory-option"
                  data-selected={selected ? 'true' : 'false'}
                  aria-pressed={selected}
                  onClick={() => onMissionChange(mission.id)}
                  style={{ '--region-hue': territories[index]?.hue || 188 } as CSSProperties}
                >
                  <span className="cds-agent-territory-option-index">{index + 1}</span>
                  <Icon aria-hidden="true" />
                  <span>
                    <strong>{mission.label}</strong>
                    <small>{fromCurrentPage ? '当前页面入口' : mission.description}</small>
                  </span>
                  {selected && <Check aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          <div className="cds-agent-territory-explainer">
            <Info aria-hidden="true" />
            <p>
              <strong>这里不是设置总数</strong>
              <span>每块地界代表一类 Agent 任务，进入后仍会读取对应页面的完整设置。</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
