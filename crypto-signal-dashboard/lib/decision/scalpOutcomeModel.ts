import type {
  ScalpCandidate,
  ScalpLearningProfile,
  ScalpOutcomeClass,
  TradeLearningOutcome,
} from "@/lib/decision/learningTypes";

export const SCALP_OUTCOME_MODEL_VERSION = "scalp-outcomes-v2-fee-aligned";
export const SCALP_OUTCOME_RETRAIN_BATCH_SIZE = 50;
export const SCALP_OUTCOME_MINIMUM_CLASS_SAMPLES = 100;
export const SCALP_OUTCOME_MINIMUM_NEUTRAL_SAMPLES = 20;
export const SCALP_OUTCOME_STRONG_CLASS_SAMPLES = 200;
export const SCALP_OUTCOME_MINIMUM_PROFITABLE_PROBABILITY = 0.7;
export const SCALP_OUTCOME_MAXIMUM_FULL_SL_PROBABILITY = 0.2;

export function evaluateValidatedScalpOutcomePrediction(input: {
  modelStatus: "insufficient-data" | "shadow" | "validated" | null | undefined;
  prediction: ScalpCandidate["prediction"];
}) {
  const profitableProbability = input.prediction
    ? input.prediction.fullTp + input.prediction.profitableStaircase
    : null;
  const enforced = input.modelStatus === "validated" && input.prediction?.calibrated === true;
  const allowed = !enforced || (
    profitableProbability! >= SCALP_OUTCOME_MINIMUM_PROFITABLE_PROBABILITY
    && input.prediction!.fullSl <= SCALP_OUTCOME_MAXIMUM_FULL_SL_PROBABILITY
  );
  return { allowed, enforced, profitableProbability };
}

const CLASSES = ["full-tp", "profitable-staircase", "full-sl", "neutral"] as const;
const KEYS = ["fullTp", "profitableStaircase", "fullSl", "neutral"] as const;
export const SCALP_OUTCOME_FEATURES = [
  "setupScore",
  "atrPercent",
  "volatilityPercent",
  "directionalNetMove5m",
  "directionalNetMove15m",
  "directionalNetMove60m",
  "directionalEmaSpread",
  "directionalEmaSlope",
  "directionalMacdHistogram",
  "directionalMacdChange",
  "directionalDiSpread",
  "directionalBollingerPosition",
  "adx",
  "volumeRatio",
  "regimeTrending",
  "regimeExhausted",
] as const;

type OutcomeModel = NonNullable<ScalpLearningProfile["outcomeModel"]>;
type ClassKey = (typeof KEYS)[number];
type Observation = { at: number; outcomeClass: ScalpOutcomeClass; features: number[] };

function finite(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function classKey(outcomeClass: ScalpOutcomeClass): ClassKey {
  return outcomeClass === "full-tp"
    ? "fullTp"
    : outcomeClass === "profitable-staircase"
      ? "profitableStaircase"
      : outcomeClass === "full-sl"
        ? "fullSl"
        : "neutral";
}

export function classifyExecutedScalpOutcome(outcome: TradeLearningOutcome): ScalpOutcomeClass {
  if (outcome.outcomeClass) return outcome.outcomeClass;
  if (outcome.exitMechanism === "full-tp" || outcome.exitReason === "take-profit") return "full-tp";
  if (
    outcome.exitMechanism === "staircase-stop"
    || outcome.exitMechanism === "staircase-market-close"
    || (outcome.netPnlUsd > 0 && (outcome.exitReason === "stop-loss" || outcome.exitReason === "manual"))
  ) return "profitable-staircase";
  if (
    outcome.exitMechanism === "hard-sl"
    || outcome.exitMechanism === "liquidation"
    || (outcome.netPnlUsd <= 0 && (outcome.exitReason === "stop-loss" || outcome.exitReason === "liquidation"))
  ) return "full-sl";
  return "neutral";
}

export function scalpCandidateFeatureVector(candidate: ScalpCandidate) {
  const m = candidate.metrics;
  const direction = candidate.side === "long" ? 1 : -1;
  return [
    finite(m.score),
    finite(m.atrPercent),
    finite(m.volatilityPercent),
    finite(m.netMove5mPercent) * direction,
    finite(m.netMove15mPercent) * direction,
    finite(m.netMove60mPercent) * direction,
    finite(m.emaSpreadPercent) * direction,
    finite(m.emaSlopePercent) * direction,
    finite(m.macdHistogram) * direction,
    finite(m.macdHistogramChange) * direction,
    (finite(m.plusDi) - finite(m.minusDi)) * direction,
    (finite(m.bollingerPosition, 0.5) - 0.5) * direction,
    finite(m.adx),
    finite(m.volumeRatio),
    finite(m.regimeTrending),
    finite(m.regimeExhausted),
  ];
}

function scalpOutcomeFeatureVector(outcome: TradeLearningOutcome) {
  const direction = outcome.side === "long" ? 1 : -1;
  return [
    finite(outcome.priceActionScore),
    finite(outcome.atrPercent),
    finite(outcome.volatilityPercent),
    0,
    0,
    finite(outcome.trendStrengthPercent) * direction,
    finite(outcome.emaSpreadPercent) * direction,
    finite(outcome.emaSlopePercent) * direction,
    finite(outcome.macdHistogram) * direction,
    finite(outcome.macdHistogramChange) * direction,
    (finite(outcome.plusDi) - finite(outcome.minusDi)) * direction,
    (finite(outcome.bollingerPosition, 0.5) - 0.5) * direction,
    finite(outcome.adx),
    finite(outcome.volumeRatio),
    outcome.trendBias === "sideways" ? 0 : 1,
    0,
  ];
}

function observations(candidates: ScalpCandidate[], outcomes: TradeLearningOutcome[]) {
  const actualByExecution = new Map(outcomes.map((outcome) => [outcome.executionId, outcome]));
  const representedExecutions = new Set<string>();
  const result: Observation[] = candidates.flatMap((candidate) => {
    const actual = candidate.executionId ? actualByExecution.get(candidate.executionId) : null;
    if (actual) representedExecutions.add(actual.executionId);
    // V1 rejected-candidate labels used smaller ATR-only barriers than live
    // execution. Keep actual executed outcomes, but do not train the v2 model
    // on those incompatible shadow labels.
    if (!actual && finite(candidate.metrics.shadowLabelVersion) < 2) return [];
    const outcomeClass = actual
      ? classifyExecutedScalpOutcome(actual)
      : candidate.outcomeClass ?? null;
    if (!outcomeClass) return [];
    return [{
      at: actual ? Date.parse(actual.closedAt) : Date.parse(candidate.observedAt) + 60 * 60_000,
      outcomeClass,
      features: scalpCandidateFeatureVector(candidate),
    }];
  });
  outcomes.forEach((outcome) => {
    if (representedExecutions.has(outcome.executionId)) return;
    result.push({
      at: Date.parse(outcome.closedAt),
      outcomeClass: classifyExecutedScalpOutcome(outcome),
      features: scalpOutcomeFeatureVector(outcome),
    });
  });
  return result
    .filter((item) => Number.isFinite(item.at))
    .sort((left, right) => left.at - right.at);
}

function counts(items: Observation[]) {
  const result = { fullTp: 0, profitableStaircase: 0, fullSl: 0, neutral: 0 };
  items.forEach((item) => { result[classKey(item.outcomeClass)] += 1; });
  return result;
}

function mean(items: number[][], index: number) {
  return items.length ? items.reduce((sum, item) => sum + item[index]!, 0) / items.length : 0;
}

function fit(items: Observation[]) {
  const vectors = items.map((item) => item.features);
  const featureScales = SCALP_OUTCOME_FEATURES.map((_, index) => {
    const average = mean(vectors, index);
    const variance = vectors.length
      ? vectors.reduce((sum, vector) => sum + (vector[index]! - average) ** 2, 0) / vectors.length
      : 0;
    return Math.max(1e-6, Math.sqrt(variance));
  });
  const centroids = Object.fromEntries(KEYS.map((key, keyIndex) => {
    const classVectors = items
      .filter((item) => classKey(item.outcomeClass) === key)
      .map((item) => item.features);
    return [key, SCALP_OUTCOME_FEATURES.map((_, index) => mean(classVectors, index))];
  })) as OutcomeModel["centroids"];
  return { featureScales, centroids };
}

export function predictScalpCandidateOutcome(model: OutcomeModel, candidate: ScalpCandidate) {
  const vector = scalpCandidateFeatureVector(candidate);
  const raw = KEYS.map((key) => {
    const count = model.classCounts[key];
    if (count === 0) return Number.NEGATIVE_INFINITY;
    const squaredDistance = vector.reduce((sum, value, index) => {
      const scale = model.featureScales[index] ?? 1;
      const delta = (value - (model.centroids[key][index] ?? 0)) / scale;
      return sum + delta * delta;
    }, 0) / Math.max(1, vector.length);
    return -squaredDistance + Math.log(count / Math.max(1, model.labeledSampleCount));
  });
  const maximum = Math.max(...raw.filter(Number.isFinite));
  const exp = raw.map((value) => Number.isFinite(value) ? Math.exp(value - maximum) : 0);
  const total = exp.reduce((sum, value) => sum + value, 0) || 1;
  return {
    modelVersion: model.modelVersion,
    calibrated: model.status === "validated",
    fullTp: exp[0]! / total,
    profitableStaircase: exp[1]! / total,
    fullSl: exp[2]! / total,
    neutral: exp[3]! / total,
  };
}

function evaluate(model: OutcomeModel, validation: Observation[]) {
  let correct = 0;
  let brier = 0;
  validation.forEach((item) => {
    // Prediction expects raw named candidate metrics, so evaluate directly on
    // the already normalized vector to avoid reversing direction twice.
    const raw = KEYS.map((key) => {
      if (model.classCounts[key] === 0) return Number.NEGATIVE_INFINITY;
      const distance = item.features.reduce((sum, value, index) => {
        const delta = (value - (model.centroids[key][index] ?? 0)) / (model.featureScales[index] ?? 1);
        return sum + delta * delta;
      }, 0) / Math.max(1, item.features.length);
      return -distance + Math.log(model.classCounts[key] / Math.max(1, model.labeledSampleCount));
    });
    const max = Math.max(...raw.filter(Number.isFinite));
    const exp = raw.map((value) => Number.isFinite(value) ? Math.exp(value - max) : 0);
    const total = exp.reduce((sum, value) => sum + value, 0) || 1;
    const probability = exp.map((value) => value / total);
    const actual = CLASSES.indexOf(item.outcomeClass);
    const predicted = probability.indexOf(Math.max(...probability));
    if (predicted === actual) correct += 1;
    brier += probability.reduce((sum, value, index) => sum + (value - (index === actual ? 1 : 0)) ** 2, 0);
  });
  return {
    accuracy: validation.length ? correct / validation.length : 0,
    brierScore: validation.length ? brier / validation.length : 0,
  };
}

export function trainScalpOutcomeModel(input: {
  candidates: ScalpCandidate[];
  outcomes: TradeLearningOutcome[];
  previous?: OutcomeModel | null;
  force?: boolean;
  trainedAt?: Date;
}): OutcomeModel {
  const labeled = observations(input.candidates, input.outcomes);
  const classCounts = counts(labeled);
  const previousIsCurrent = input.previous?.modelVersion === SCALP_OUTCOME_MODEL_VERSION;
  const lastTrainedSampleCount = previousIsCurrent && input.previous?.trainedAt
    ? input.previous.labeledSampleCount
    : 0;
  const newLabelsSinceTraining = Math.max(0, labeled.length - lastTrainedSampleCount);
  if (
    previousIsCurrent
    && input.previous
    && !input.force
    && newLabelsSinceTraining < SCALP_OUTCOME_RETRAIN_BATCH_SIZE
  ) return input.previous;
  if (labeled.length < SCALP_OUTCOME_RETRAIN_BATCH_SIZE) {
    return {
      modelVersion: SCALP_OUTCOME_MODEL_VERSION,
      status: "insufficient-data",
      trainedAt: null,
      labeledSampleCount: labeled.length,
      newLabelsSinceTraining,
      classCounts,
      minimumClassSamples: SCALP_OUTCOME_MINIMUM_CLASS_SAMPLES,
      minimumNeutralSamples: SCALP_OUTCOME_MINIMUM_NEUTRAL_SAMPLES,
      strongBaselineClassSamples: SCALP_OUTCOME_STRONG_CLASS_SAMPLES,
      retrainBatchSize: SCALP_OUTCOME_RETRAIN_BATCH_SIZE,
      featureNames: [...SCALP_OUTCOME_FEATURES],
      featureScales: SCALP_OUTCOME_FEATURES.map(() => 1),
      centroids: { fullTp: [], profitableStaircase: [], fullSl: [], neutral: [] },
      validation: {
        trainingSize: 0,
        validationSize: 0,
        accuracy: 0,
        brierScore: 0,
        chronological: true,
        passed: false,
        reasons: [`${labeled.length}/${SCALP_OUTCOME_RETRAIN_BATCH_SIZE} resolved outcomes are available for the first shadow challenger.`],
      },
    };
  }
  const split = Math.max(1, Math.floor(labeled.length * 0.8));
  const training = labeled.slice(0, split);
  const validation = labeled.slice(split);
  const fitted = fit(training);
  let provisional: OutcomeModel = {
    modelVersion: SCALP_OUTCOME_MODEL_VERSION,
    status: "shadow" as const,
    trainedAt: (input.trainedAt ?? new Date()).toISOString(),
    labeledSampleCount: labeled.length,
    newLabelsSinceTraining: 0,
    classCounts,
    minimumClassSamples: SCALP_OUTCOME_MINIMUM_CLASS_SAMPLES,
    minimumNeutralSamples: SCALP_OUTCOME_MINIMUM_NEUTRAL_SAMPLES,
    strongBaselineClassSamples: SCALP_OUTCOME_STRONG_CLASS_SAMPLES,
    retrainBatchSize: SCALP_OUTCOME_RETRAIN_BATCH_SIZE,
    featureNames: [...SCALP_OUTCOME_FEATURES],
    ...fitted,
    validation: {
      trainingSize: training.length,
      validationSize: validation.length,
      accuracy: 0,
      brierScore: 0,
      chronological: true as const,
      passed: false,
      reasons: [] as string[],
    },
  };
  const measured = evaluate(provisional, validation);
  const hasClassCoverage = classCounts.fullTp >= SCALP_OUTCOME_MINIMUM_CLASS_SAMPLES
    && classCounts.profitableStaircase >= SCALP_OUTCOME_MINIMUM_CLASS_SAMPLES
    && classCounts.fullSl >= SCALP_OUTCOME_MINIMUM_CLASS_SAMPLES
    && classCounts.neutral >= SCALP_OUTCOME_MINIMUM_NEUTRAL_SAMPLES;
  const validationPassed = hasClassCoverage
    && validation.length >= 40
    && measured.accuracy >= 0.4
    && measured.brierScore < 0.75;
  provisional.status = validationPassed ? "validated" : "shadow";
  provisional.validation = {
    ...provisional.validation,
    accuracy: Number(measured.accuracy.toFixed(6)),
    brierScore: Number(measured.brierScore.toFixed(6)),
    passed: validationPassed,
    reasons: validationPassed
      ? ["The challenger passed strict chronological validation with at least 100 full-TP, profitable-staircase, and full-SL examples plus 20 neutral examples."]
      : [hasClassCoverage
          ? "The challenger remains shadow-only because chronological accuracy or calibration did not pass."
          : "The challenger remains shadow-only until full TP, profitable staircase, and full SL each have 100 examples and neutral has 20; 200 per class remains the strong-baseline target."],
  };
  return provisional;
}
