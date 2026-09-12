export type GrowthVariety = "rawit" | "merah" | "keriting" | "unknown";

export type GrowthBand = { min: number; max: number };

type GrowthPoint = {
  hst: number;
  height?: GrowthBand;
  canopy?: GrowthBand;
  leaves?: GrowthBand;
};

type GrowthProfile = {
  sourceId: string;
  sourceLabel: string;
  variety: "rawit" | "merah" | "all";
  points: GrowthPoint[];
};

export type GrowthMeasures = {
  heightCm: number | null;
  canopyCm: number | null;
  leafCount: number | null;
  leafWidthCm: number | null;
};

export type GrowthMetric = {
  name: "tinggi" | "lebar tajuk" | "jumlah daun";
  value: number;
  benchmark: GrowthBand;
  status: "ok" | "low" | "high";
  label: "Sesuai" | "Di bawah benchmark" | "Di atas benchmark";
};

export type GrowthAssessment = {
  status: "ok" | "low" | "high" | "data";
  label:
    | "Sesuai"
    | "Di bawah benchmark"
    | "Di atas benchmark"
    | "Data Belum Cukup";
  confidence: number;
  deviation: number | null;
  benchmark: {
    sourceId: string;
    sourceLabel: string;
    hst: number;
    interpolated: boolean;
    height?: GrowthBand;
    canopy?: GrowthBand;
    leaves?: GrowthBand;
  } | null;
  metrics: GrowthMetric[];
};

const REFERENCES: GrowthProfile[] = [
  {
    sourceId: "early-rawit",
    sourceLabel: "Studi pertumbuhan cabai rawit — fase awal",
    variety: "rawit",
    points: [
      { hst: 7, height: { min: 7.4, max: 8.8 } },
      { hst: 14, height: { min: 12.2, max: 14.5 } },
      { hst: 21, height: { min: 20.5, max: 23.6 } },
      { hst: 28, height: { min: 29, max: 35.4 } },
    ],
  },
  {
    sourceId: "mid-balitsa",
    sourceLabel: "Karakterisasi/percobaan cabai merah — fase 35/65 HST",
    variety: "merah",
    points: [
      {
        hst: 35,
        height: { min: 18.5, max: 23.9 },
        canopy: { min: 14.9, max: 16.3 },
        leaves: { min: 18, max: 25 },
      },
      {
        hst: 65,
        height: { min: 47.9, max: 69.8 },
        canopy: { min: 43.6, max: 58 },
        leaves: { min: 61, max: 77 },
      },
    ],
  },
];

function midpoint(a: number, b: number): number {
  return (a + b) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function interpolateBand(a: GrowthBand | undefined, b: GrowthBand | undefined, t: number): GrowthBand | undefined {
  if (!a || !b) return undefined;
  return {
    min: a.min + (b.min - a.min) * t,
    max: a.max + (b.max - a.max) * t,
  };
}

function benchmarkForHst(hst: number, variety: GrowthVariety): GrowthAssessment["benchmark"] {
  if (!Number.isFinite(hst) || hst < 0 || variety === "unknown" || variety === "keriting") return null;

  const profile = REFERENCES.find((item) => item.variety === variety);
  if (!profile) return null;

  const { points } = profile;
  if (hst < points[0].hst || hst > points[points.length - 1].hst) return null;

  const exact = points.find((point) => point.hst === hst);
  if (exact) {
    return {
      sourceId: profile.sourceId,
      sourceLabel: profile.sourceLabel,
      hst,
      interpolated: false,
      height: exact.height,
      canopy: exact.canopy,
      leaves: exact.leaves,
    };
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (hst < left.hst || hst > right.hst) continue;

    const t = (hst - left.hst) / (right.hst - left.hst);
    return {
      sourceId: profile.sourceId,
      sourceLabel: profile.sourceLabel,
      hst,
      interpolated: true,
      height: interpolateBand(left.height, right.height, t),
      canopy: interpolateBand(left.canopy, right.canopy, t),
      leaves: interpolateBand(left.leaves, right.leaves, t),
    };
  }

  return null;
}

function metricStatus(value: number | null, benchmark: GrowthBand | undefined): GrowthMetric["status"] | null {
  if (value === null || benchmark === undefined) return null;
  if (value < benchmark.min) return "low";
  if (value > benchmark.max) return "high";
  return "ok";
}

function metricLabel(status: GrowthMetric["status"]): GrowthMetric["label"] {
  if (status === "low") return "Di bawah benchmark";
  if (status === "high") return "Di atas benchmark";
  return "Sesuai";
}

function deviationFromBand(value: number, benchmark: GrowthBand): number {
  const center = midpoint(benchmark.min, benchmark.max);
  const halfSpan = Math.max(0.001, (benchmark.max - benchmark.min) / 2);
  return ((value - center) / halfSpan) * 100;
}

export function assessGrowth(hst: number | null, variety: GrowthVariety, measures: GrowthMeasures): GrowthAssessment {
  if (hst === null || !Number.isFinite(hst)) {
    return {
      status: "data",
      label: "Data Belum Cukup",
      confidence: 20,
      deviation: null,
      benchmark: null,
      metrics: [],
    };
  }

  const benchmark = benchmarkForHst(hst, variety);
  if (!benchmark) {
    return {
      status: "data",
      label: "Data Belum Cukup",
      confidence: 30,
      deviation: null,
      benchmark: null,
      metrics: [],
    };
  }

  const candidates: Array<[GrowthMetric["name"], number | null, GrowthBand | undefined]> = [
    ["tinggi", measures.heightCm, benchmark.height],
    ["lebar tajuk", measures.canopyCm, benchmark.canopy],
    ["jumlah daun", measures.leafCount, benchmark.leaves],
  ];

  const metrics: GrowthMetric[] = candidates.flatMap(([name, value, band]) => {
    const status = metricStatus(value, band);
    if (status === null || value === null || band === undefined) return [];
    return [{
      name,
      value,
      benchmark: band,
      status,
      label: metricLabel(status),
    }];
  });

  if (!metrics.length) {
    return {
      status: "data",
      label: "Data Belum Cukup",
      confidence: 30,
      deviation: null,
      benchmark,
      metrics: [],
    };
  }

  const low = metrics.filter((metric) => metric.status === "low").length;
  const high = metrics.filter((metric) => metric.status === "high").length;
  let status: GrowthAssessment["status"] = "ok";
  let label: GrowthAssessment["label"] = "Sesuai";

  if (low > high && low >= Math.ceil(metrics.length / 2)) {
    status = "low";
    label = "Di bawah benchmark";
  } else if (high > low && high >= Math.ceil(metrics.length / 2)) {
    status = "high";
    label = "Di atas benchmark";
  }

  const deviations = metrics.map((metric) => deviationFromBand(metric.value, metric.benchmark));
  const deviation = Math.round(deviations.reduce((sum, value) => sum + value, 0) / deviations.length);
  const agreementBonus = Math.max(0, metrics.length - Math.max(low, high)) * 5;
  const confidence = Math.round(clamp(55 + metrics.length * 10 + agreementBonus, 0, 95));

  return {
    status,
    label,
    confidence,
    deviation,
    benchmark,
    metrics,
  };
}

export function growthReferenceMeta(): { version: "1.0"; sourceCount: number; rules: string[] } {
  return {
    version: "1.0",
    sourceCount: REFERENCES.length,
    rules: [
      "Do not interpolate between different source profiles.",
      "Do not treat benchmark ranges as universal standards.",
      "Use date of planting/transplanting for calendar HST.",
      "Use visual morphology as a relative growth signal, not definitive age.",
      "When benchmark is unavailable, return Data Belum Cukup.",
    ],
  };
}
