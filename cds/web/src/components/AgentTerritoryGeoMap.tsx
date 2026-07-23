import { type CSSProperties, type KeyboardEvent } from 'react';
import { geoGraticule10, geoNaturalEarth1, geoPath } from 'd3-geo';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { Check, type LucideIcon } from 'lucide-react';

import africaMapJson from '@/data/africa-110m.geo.json';
import type { AgentPageContextId } from '@/lib/agent-onboarding';

export interface AgentTerritoryMission {
  id: AgentPageContextId;
  label: string;
  description: string;
  icon: LucideIcon;
}

interface AfricaCountryProperties {
  id: string;
  name: string;
}

interface TerritoryDefinition {
  countryIds: readonly string[];
  labelCoordinate: readonly [number, number];
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

const TERRITORIES: TerritoryDefinition[] = [
  {
    countryIds: ['MAR', 'SAH', 'DZA', 'TUN', 'LBY', 'EGY'],
    labelCoordinate: [8, 28],
    hue: 186,
  },
  {
    countryIds: [
      'MRT', 'MLI', 'NER', 'SEN', 'GMB', 'GNB', 'GIN', 'SLE', 'LBR',
      'CIV', 'BFA', 'GHA', 'TGO', 'BEN', 'NGA',
    ],
    labelCoordinate: [-4, 11],
    hue: 198,
  },
  {
    countryIds: ['TCD', 'CMR', 'CAF', 'GNQ', 'GAB', 'COG', 'COD'],
    labelCoordinate: [19, 4],
    hue: 211,
  },
  {
    countryIds: [
      'SDN', 'SDS', 'ERI', 'DJI', 'ETH', 'SOM', 'SOL', 'KEN', 'UGA',
      'RWA', 'BDI', 'TZA',
    ],
    labelCoordinate: [37, 7],
    hue: 224,
  },
  {
    countryIds: [
      'AGO', 'ZMB', 'MWI', 'MOZ', 'ZWE', 'BWA', 'NAM', 'ZAF', 'LSO',
      'SWZ', 'MDG',
    ],
    labelCoordinate: [25, -24],
    hue: 246,
  },
];

const AFRICA_MAP = africaMapJson as FeatureCollection<Geometry, AfricaCountryProperties>;
const AFRICA_COUNTRIES = AFRICA_MAP.features as Array<
  Feature<Geometry, AfricaCountryProperties>
>;
const AFRICA_PROJECTION = geoNaturalEarth1().fitExtent(
  [[34, 24], [586, 396]],
  AFRICA_MAP,
);
const AFRICA_PATH = geoPath(AFRICA_PROJECTION);
const AFRICA_GRATICULE_PATH = AFRICA_PATH(geoGraticule10()) || '';

function territoryCountries(index: number, missionCount: number): Array<
  Feature<Geometry, AfricaCountryProperties>
> {
  if (missionCount === 1) return AFRICA_COUNTRIES;
  const ids = new Set(TERRITORIES[index]?.countryIds || []);
  return AFRICA_COUNTRIES.filter((feature) => ids.has(feature.properties.id));
}

function territoryMarker(index: number, missionCount: number): [number, number] {
  const coordinates = missionCount === 1
    ? [18, 2] as const
    : TERRITORIES[index]?.labelCoordinate || TERRITORIES[0].labelCoordinate;
  return AFRICA_PROJECTION([coordinates[0], coordinates[1]]) || [310, 210];
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
  const selectedTerritoryIndex = Math.max(
    0,
    missions.findIndex((mission) => mission.id === selectedMissionId),
  );

  return (
    <div
      className="cds-agent-world-stage"
      data-single-region={singleRegion ? 'true' : 'false'}
    >
      <div className="cds-agent-world-canvas">
        <div className="cds-agent-world-map-surface">
          <svg
            className="cds-agent-world-svg"
            viewBox="0 0 620 420"
            role="group"
            aria-label={`${continentName}真实地理地界地图`}
          >
            <defs>
              <filter id="agent-map-selected-glow" x="-35%" y="-35%" width="170%" height="170%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <path
              className="cds-agent-world-graticule"
              d={AFRICA_GRATICULE_PATH}
              aria-hidden="true"
            />
            <g className="cds-agent-world-hud" aria-hidden="true">
              <text x="18" y="24">NATURAL EARTH · AFRICA 110M</text>
              <text x="602" y="24" textAnchor="end">REAL GEOGRAPHY</text>
            </g>

            {missions.map((mission, index) => {
              const selected = mission.id === selectedMissionId;
              const countries = territoryCountries(index, missions.length);
              const [markerX, markerY] = territoryMarker(index, missions.length);
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
                    '--region-hue': TERRITORIES[index]?.hue || 188,
                  } as CSSProperties}
                >
                  {countries.map((country) => (
                    <path
                      key={country.properties.id}
                      className="cds-agent-world-region-fill"
                      d={AFRICA_PATH(country) || undefined}
                    >
                      <title>{country.properties.name}</title>
                    </path>
                  ))}
                  {selected && (
                    <circle
                      key={`${mission.id}-pulse`}
                      className="cds-agent-world-selected-pulse"
                      cx={markerX}
                      cy={markerY}
                      r="21"
                      aria-hidden="true"
                    />
                  )}
                  <g
                    className="cds-agent-world-territory-marker"
                    data-selected={selected ? 'true' : 'false'}
                    transform={`translate(${markerX} ${markerY})`}
                    aria-hidden="true"
                  >
                    <circle r="14" />
                    <text y="4">{index + 1}</text>
                  </g>
                </g>
              );
            })}
          </svg>

          <div className="cds-agent-world-map-source">
            <span>真实国界</span>
            <strong>Natural Earth</strong>
          </div>
        </div>

        <div className="cds-agent-territory-legend" aria-label="任务地界目录">
          <div className="cds-agent-territory-legend-heading">
            <span>任务地界</span>
            <strong>{selectedTerritoryIndex + 1} / {missions.length}</strong>
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
                  style={{ '--region-hue': TERRITORIES[index]?.hue || 188 } as CSSProperties}
                >
                  <span className="cds-agent-territory-option-index">{index + 1}</span>
                  <Icon aria-hidden="true" />
                  <span>
                    <strong>{mission.label}</strong>
                    <small>{fromCurrentPage ? '当前位置' : mission.description}</small>
                  </span>
                  {selected && <Check aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          <p>点击真实地理区域或右侧任务，选择结果保持一致。</p>
        </div>
      </div>
    </div>
  );
}
