/**
 * Demo scenario registry.
 *
 * The three primary presets are bound to media pairs that already exist in
 * `mockdata/media/.triage_cache`. Triage is memoised on
 * sha256("<photo_ref>|<voice_ref>"), so these presets return instantly and
 * burn ZERO Gemini quota — which is what makes the 2-minute demo reliable.
 *
 * Because the cache key is the literal ref string, the refs below are absolute
 * Windows paths produced the same way backend/help_bot_runner.py produces them
 * (`str(_REPO_ROOT / relative)`). Override VITE_MEDIA_ROOT if the repo moves,
 * otherwise the presets silently fall through to live AI calls.
 *
 * Verified cache contents (all three resolve to tier=critical):
 *   PhotoshopExtension_Image (1).png + ungli.mp3  -> machine_entanglement,
 *       heavy_bleeding, traumatic_amputation      -> branch heavy_bleeding
 *   PhotoshopExtension_Image.png     + taang.mp3  -> heavy_bleeding,
 *       major_trauma, deep_open_wound             -> branch fracture_crush
 *   PhotoshopExtension_Image (2).png + saanp.mp3  -> venomous_snake_bite,
 *       puncture_wounds                           -> branch snakebite
 */

import type { HelpBotBranch, SeverityTier } from './types'

/** Repo-local mockdata root. Backslash form matters — it is part of the hash. */
const MEDIA_ROOT = (
  import.meta.env.VITE_MEDIA_ROOT ?? 'D:\\LifeLine Ride\\mockdata'
).replace(/\/+$/, '').replace(/\\+$/, '')

/** Join with backslashes to match Python's str(Path(...)) on Windows. */
function mediaPath(relative: string): string {
  return `${MEDIA_ROOT}\\${relative.replace(/\//g, '\\')}`
}

export function photoRef(name: string): string {
  return mediaPath(`media\\photos\\${name}`)
}

export function voiceRef(name: string): string {
  return mediaPath(`media\\voice\\${name}`)
}

export interface Scenario {
  id: string
  title_en: string
  title_ur: string
  subtitle_en: string
  village_id: string
  photo_ref: string
  voice_ref: string
  /** Tier the cached triage result is known to produce. */
  expected_tier: SeverityTier
  expected_flags: string[]
  expected_branch: HelpBotBranch
  /** true = served from .triage_cache (instant, zero quota). */
  cache_backed: boolean
  accent: 'critical' | 'cyan' | 'ash'
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'farm-machinery',
    title_en: 'Severe Farm Machinery Laceration',
    title_ur: 'مشین سے شدید زخم',
    subtitle_en: 'Hand caught in thresher — machine entanglement, heavy bleeding',
    village_id: 'VILLAGE-A',
    photo_ref: photoRef('PhotoshopExtension_Image (1).png'),
    voice_ref: voiceRef('ungli.mp3'),
    expected_tier: 'critical',
    expected_flags: ['machine_entanglement', 'heavy_bleeding', 'traumatic_amputation'],
    expected_branch: 'heavy_bleeding',
    cache_backed: true,
    accent: 'critical',
  },
  {
    id: 'crush-fall',
    title_en: 'Fall with Suspected Fracture & Crush Injury',
    title_ur: 'گر کر ہڈی کا فریکچر اور کچلنے کا زخم',
    subtitle_en: 'Stone block fell on leg — major trauma, deep open wound',
    village_id: 'VILLAGE-B',
    photo_ref: photoRef('PhotoshopExtension_Image.png'),
    voice_ref: voiceRef('taang.mp3'),
    expected_tier: 'critical',
    expected_flags: ['heavy_bleeding', 'major_trauma', 'deep_open_wound'],
    expected_branch: 'fracture_crush',
    cache_backed: true,
    accent: 'critical',
  },
  {
    id: 'snakebite',
    title_en: 'Venomous Snakebite',
    title_ur: 'زہریلے سانپ کا کاٹنا',
    subtitle_en: 'Snake bite while cutting grass — puncture wounds, venom risk',
    village_id: 'VILLAGE-A',
    photo_ref: photoRef('PhotoshopExtension_Image (2).png'),
    voice_ref: voiceRef('saanp.mp3'),
    expected_tier: 'critical',
    expected_flags: ['venomous_snake_bite', 'puncture_wounds'],
    expected_branch: 'snakebite',
    cache_backed: true,
    accent: 'critical',
  },
  {
    id: 'failsafe-degraded',
    // Rule-mandated fail-safe: unusable media must NOT block dispatch — it
    // defaults to Tier 2 (moderate) flagged low_confidence_triage. This preset
    // deliberately points at missing files to demonstrate that guardrail live.
    title_en: 'Fail-Safe: Blurry Photo / Inaudible Audio',
    title_ur: 'ناقص ریکارڈنگ — محفوظ ترین درجہ بندی',
    subtitle_en: 'Proves the guardrail: degrades to moderate + low_confidence_triage',
    village_id: 'VILLAGE-A',
    photo_ref: 'unreadable_photo.jpg',
    voice_ref: 'inaudible_voice_note.mp3',
    expected_tier: 'moderate',
    expected_flags: ['low_confidence_triage'],
    expected_branch: 'heavy_bleeding',
    // Not cached: STT and vision short-circuit on the missing files, but the
    // classifier still makes one live call on the separate-budget lite model.
    cache_backed: false,
    accent: 'cyan',
  },
]

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}

// ---------------------------------------------------------------------------
// Help-bot quick replies
// ---------------------------------------------------------------------------

export interface QuickReply {
  id: string
  label_en: string
  /** Sent verbatim as `responder_transcript`. */
  transcript_ur: string
  /** Intent the verified replay fixtures expect for this utterance. */
  expect: 'step_done' | 'in_scope_question' | 'out_of_scope' | 'escalation'
  tone: 'mint' | 'cyan' | 'critical'
}

/**
 * Transcripts copied from mockdata/helpbot/scripts/*.json — these exact
 * utterances are asserted against their intent labels in the replay artifacts,
 * so the classifier's behaviour on them is already verified rather than hoped
 * for.
 */
const STEP_DONE_BY_BRANCH: Record<HelpBotBranch, string> = {
  heavy_bleeding: 'ٹھیک ہے، زخم پر کپڑا رکھ کر دباؤ ڈال دیا ہے',
  fracture_crush: 'مریض کو لٹا دیا ہے اور ٹانگ بالکل نہیں ہلا رہا',
  snakebite: 'مریض کو لٹا دیا ہے، کٹا ہوا ہاتھ بالکل حرکت نہیں دے رہا',
}

const NEXT_STEP_BY_BRANCH: Partial<Record<HelpBotBranch, string>> = {
  heavy_bleeding: 'ہاتھ اوپر اٹھا دیا ہے، اگلا قدم بتائیں',
  snakebite: 'کڑا اور گھڑی اتار دی ہے',
}

const IN_SCOPE_BY_BRANCH: Record<HelpBotBranch, string> = {
  heavy_bleeding:
    'کپڑا خون سے بالکل بھیگ گیا ہے، کیا میں اسے اتار کر نیا کپڑا لگا دوں؟',
  fracture_crush: 'یہاں کوئی تختہ یا سخت چیز نہیں مل رہی، کیا کروں؟',
  snakebite: 'کیا میں کٹنے کے اوپر کپڑا یا پٹی کس کر باندھ دوں؟',
}

const ESCALATION_BY_BRANCH: Record<HelpBotBranch, string> = {
  heavy_bleeding: 'خون نہیں رک رہا اور مریض بے ہوش ہو رہا ہے',
  fracture_crush: 'مریض بے ہوش ہو رہا ہے اور سانس میں تکلیف ہے',
  snakebite: 'مریض کو سانس لینے میں بہت تکلیف ہو رہی ہے',
}

const OUT_OF_SCOPE_BY_BRANCH: Record<HelpBotBranch, string> = {
  heavy_bleeding:
    'مریض کہہ رہا ہے اسے شدید پیاس لگی ہے، کیا میں اسے پانی پلا دوں؟',
  fracture_crush: 'مریض کو پانی یا درد کی گولی دے سکتے ہیں؟',
  snakebite: 'کیا مریض کو بخار کی گولی دے دوں؟',
}

/** Branch-aware quick replies. Falls back to heavy_bleeding (the backend's
 *  DEFAULT_BRANCH — safest default: pressure guidance first). */
export function quickRepliesFor(branch: HelpBotBranch | string): QuickReply[] {
  const b = (branch in STEP_DONE_BY_BRANCH ? branch : 'heavy_bleeding') as HelpBotBranch
  const replies: QuickReply[] = [
    {
      id: 'step-done',
      label_en: 'Step Completed',
      transcript_ur: STEP_DONE_BY_BRANCH[b],
      expect: 'step_done',
      tone: 'mint',
    },
    {
      id: 'in-scope',
      label_en: 'Ask In-Scope Question',
      transcript_ur: IN_SCOPE_BY_BRANCH[b],
      expect: 'in_scope_question',
      tone: 'cyan',
    },
    {
      id: 'bleeding',
      label_en: 'Bleeding Not Stopping — Escalate',
      transcript_ur: ESCALATION_BY_BRANCH[b],
      expect: 'escalation',
      tone: 'critical',
    },
    {
      id: 'unconscious',
      label_en: 'Patient Losing Consciousness — Escalate',
      transcript_ur: 'مریض بے ہوش ہو رہا ہے',
      expect: 'escalation',
      tone: 'critical',
    },
    {
      id: 'out-of-scope',
      label_en: 'Ask Out-of-Scope Question',
      transcript_ur: OUT_OF_SCOPE_BY_BRANCH[b],
      expect: 'out_of_scope',
      tone: 'cyan',
    },
  ]

  const next = NEXT_STEP_BY_BRANCH[b]
  if (next) {
    replies.splice(1, 0, {
      id: 'next-step',
      label_en: 'Ask for Next Step',
      transcript_ur: next,
      expect: 'step_done',
      tone: 'mint',
    })
  }
  return replies
}
