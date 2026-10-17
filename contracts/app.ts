/** Proposed v1 API contract. Hardware capability fields describe observations, not promises. */
export type RearScene = 'idle' | 'collecting' | 'resting' | 'watering' | 'listening';
export interface CalorieRange { min: number; max: number }
export interface MacroGrams { proteinG: number; carbsG: number; fatG: number }
export interface CaptureMetadata {
  schema_version: 1;
  capture_id: string;
  device_id: string;
  boot_id: string;
  sequence: number;
  captured_at: string | null;
  time_source: 'ntp' | 'server' | 'phone' | 'unsynchronized';
  uptime_ms: number;
  mime_type?: string;
  width?: number;
  height?: number;
  session_id?: string;
  capture_window_id?: string;
  capture_phase?: 'probe' | 'followup';
}
export interface Meal {
  id: string;
  version: number;
  title: string;
  source: 'esp32' | 'phone' | 'import';
  status: 'pending_analysis' | 'estimated' | 'confirmed';
  createdAt: string;
  updatedAt: string;
  capturedAt: string | null;
  imageUrl: string;
  captureCount: number;
  images: Array<{ id: string; imageUrl: string; capturedAt: string | null; receivedAt: string }>;
  analysis: {
    status: 'not_configured' | 'pending' | 'ready' | 'failed';
    provider: 'model' | null;
    modelName: string | null;
    foods: Array<{ name: string; estimatedGrams: number | null }>;
    calorieRange: CalorieRange | null;
    /** Rough whole-plate macronutrient estimate in grams; null when the model cannot judge. */
    macros?: MacroGrams | null;
    uncertainties: string[];
    analyzedAt: string | null;
    error: string | null;
    captureIds?: string[];
    imageQuality?: 'clear' | 'uncertain' | 'unusable' | 'unknown';
  };
  portionFraction: number | null;
  consumedCalorieRange: CalorieRange | null;
  consumedMacros?: MacroGrams | null;
  note: string;
  confirmedAt: string | null;
  corrections: Array<{ portionFraction: number; note: string; createdAt: string }>;
}
export interface CompanionPost {
  id: string;
  kind: 'shared-experience' | 'virtual-life';
  body: string;
  createdAt: string;
  mealId: string | null;
  sourceEventIds: string[];
  replies: Array<{ id: string; role: 'user' | 'assistant'; body: string; createdAt: string; mode: 'user' | 'local-rules' | 'model' }>;
}
export interface MealProposal {
  mealId: string;
  expectedVersion: number;
  portionFraction: number | null;
  /** Original user wording, retained as a draft until explicit confirmation. */
  note: string;
}
/** A stored photo that has no meal of its own, e.g. a first frame the review found no food in. */
export interface CaptureRecord {
  id: string;
  imageUrl: string;
  source: 'esp32' | 'phone';
  receivedAt: string;
  capturedAt: string | null;
  mimeType: string | null;
  review: {
    sessionId: string;
    status: string;
    reason: string | null;
    foodDetected: boolean | null;
    imageUrl: string | null;
    expiresAt: string;
    mealId: string | null;
  } | null;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  mode: 'user' | 'local-rules' | 'model';
  mealId?: string | null;
  mealProposal?: MealProposal | null;
}
export interface CaptureWindow {
  id: string;
  signalId: string;
  startedAt: string;
  expiresAt: string;
  maxCaptures: number;
  captureIntervalSeconds: number;
  remaining: number;
  phase: 'probe' | 'followup';
  sessionId: string;
  phaseMaxCaptures: number;
}
export interface CaptureReview {
  sessionId: string;
  status: 'waiting_photo' | 'checking' | 'waiting_retry' | 'food_found' | 'complete' | 'no_food' | 'uncertain' | 'failed' | 'cancelled';
  reason: string | null;
  imageUrl: string | null;
  foodDetected: boolean | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  mealId: string | null;
}
export interface ContextSignal {
  signalId: string;
  stage: 'start_soon' | 'invited' | 'eating_now' | 'finished' | 'declined' | 'unrelated' | 'uncertain';
  action: 'defer' | 'ignore' | 'cancel' | 'soft_reminder' | 'capture_window' | 'phone_capture';
  reason: string;
  dryRun: boolean;
  receivedAt: string;
  captureWindowSeconds: number;
  captureIntervalSeconds: number;
  maxCaptures: number;
  classification: {
    source: 'local-rules' | 'agentjev' | 'decider';
    model: string | null;
    evidence: string;
    domainCalibrated: false;
    probability: number | null;
    margin: number | null;
    execution?: 'android-local' | 'host-local';
    runtime?: string | null;
    modelSha256?: string | null;
    modelAssessment?: {
      stage: ContextSignal['stage']; probability: number; margin: number;
      distribution: Record<ContextSignal['stage'], number>; wallMs: number | null;
      execution: 'android-local' | 'host-local'; runtime: string | null; modelSha256: string | null;
    };
  };
}
export interface PersonalProfile {
  nickname: string;
  gender: 'undisclosed' | 'female' | 'male';
  age: number | null;
  heightCm: number | null;
  weightKg: number | null;
  goal: 'balanced' | 'weight-management' | 'fitness' | 'understand' | null;
  dietaryNotes: string;
  /** User-set daily kcal reference; null means the app may suggest one from the profile. */
  calorieTarget?: number | null;
  updatedAt: string | null;
}
export interface AppState {
  schemaVersion: 1;
  now: string;
  profile: PersonalProfile;
  /** Dining has its own routes (/api/dining); the page state deliberately no longer carries it. */
  dining?: DiningState;
  config: { analysisConfigured: boolean; analysisMode: 'model' | 'unconfigured'; chatMode: 'model' | 'local-rules'; localOnly: boolean };
  device: {
    paused: boolean;
    phoneConnected: boolean;
    cameraConnected: boolean;
    deviceId: string | null;
    lastSeenAt: string | null;
    captureIntervalSeconds: number;
    rearDisplay: 'unverified' | 'adb-relay' | 'native';
    captureMode: 'signals';
    captureWindow: CaptureWindow | null;
    captureReview: CaptureReview | null;
    rootAvailable: boolean | null;
    phoneModel: string | null;
    pendingUploads: number | null;
  };
  companion: { name: string; scene: RearScene; sceneUntil: string | null; companionDays: number; memoriesCount: number; relationshipLabel: string };
  meals: Meal[];
  /** Photos the camera took that never became a meal, kept so the page can still show them. */
  captures?: CaptureRecord[];
  posts: CompanionPost[];
  /** The conversation, oldest first once reversed for display; this is the only message list sent. */
  messages: ChatMessage[];
  signals: ContextSignal[];
  reminder: { body: string; createdAt: string; expiresAt: string; signalId: string } | null;
  notices: Array<{ code: string; title: string; detail: string }>;
}

export interface DiningLocationInput {
  longitude: number;
  latitude: number;
  coordinateSystem: 'gcj02' | 'wgs84';
  accuracyMeters: number;
  observedAt: string;
}
export interface DiningPreferences {
  proactiveEnabled: boolean;
  mealTimeEnabled: boolean;
  style: 'balanced' | 'lighter' | 'plant-forward';
  radiusMeters: number;
  maxCostYuan: number | null;
  excludedKeywords: string[];
  mealTimes: { lunch: string; dinner: string };
  version: number;
  updatedAt: string | null;
}
export interface DiningPoint { longitude: number; latitude: number; coordinateSystem: 'gcj02' }
export interface DiningWalking {
  status: 'ready' | 'unavailable';
  distanceMeters: number | null;
  durationSeconds: number | null;
  source: 'amap' | null;
}
export interface DiningCard {
  id: string;
  version: number;
  kind: 'restaurant_recommendation';
  layout: 'single';
  status: 'active' | 'selected' | 'dismissed' | 'expired' | 'superseded';
  source: 'explicit_request' | 'meal_intent' | 'meal_time';
  mealKey: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  title: string;
  body: string;
  closedReason: string | null;
  restaurant: {
    id: string; name: string; address: string; type: string; typecode: string;
    location: DiningPoint; navigationLocation: DiningPoint; straightDistanceMeters: number;
    tags: string[]; costYuan: number | null; rating: number | null;
    openingHoursToday: string | null; openingHoursDescription: string | null;
    openingStatus: 'within_hours' | 'outside_hours' | 'unknown';
    photoUrl: string | null; fetchedAt: string; source: 'amap'; walking: DiningWalking;
  };
  recommendation: {
    reasons: Array<{ source: 'amap'; field: string; text: string }>;
    orderingTips: string[];
    uncertainties: string[];
    nutrition: null;
  };
  partialSearch: boolean;
  actions: { swapAvailable: boolean; navigationAvailable: boolean; dismissAvailable: boolean };
}
export interface DiningJob {
  id: string;
  requestId: string;
  type: 'recommend' | 'swap';
  source: DiningCard['source'];
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  attempts: number;
  cardId: string | null;
  resultVersion: number | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
export interface DiningState {
  schemaVersion: 1;
  now: string;
  config: { provider: 'amap'; configured: boolean; layout: 'single'; timeZone: 'Asia/Shanghai';
    locationMaxAgeSeconds: number; locationMaxAccuracyMeters: number; cardMaxAgeSeconds: number; notificationTransport: 'outbox' };
  preferences: DiningPreferences;
  location: { status: 'missing' | 'fresh' | 'stale' | 'inaccurate'; observedAt: string | null;
    accuracyMeters: number | null; coordinateSystem?: 'gcj02' | 'wgs84' };
  card: DiningCard | null;
  lastJob: DiningJob | null;
}
export interface DiningRequestResult { job: DiningJob; card: DiningCard | null; duplicate?: boolean }
export interface DiningActionInput { requestId: string; expectedVersion: number }
export interface DiningNavigation {
  cardId: string; version: number; restaurantName: string; walking: DiningWalking;
  provider: 'amap'; mode: 'walk'; url: string; fallbackUrl: string; destination: DiningPoint;
}
export interface DiningDelivery {
  id: string; cardId: string; status: 'pending' | 'acknowledged' | 'withdrawn';
  type: 'restaurant_recommendation'; title: string; body: string; createdAt: string;
  updatedAt: string; expiresAt: string; reason?: string;
}
