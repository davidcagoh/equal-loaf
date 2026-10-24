function safeEnum(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

export function deriveAudioBenchOutcome(snapshot) {
  const usage = snapshot?.usage;
  const limits = snapshot?.limits;
  const turnLimit = limits?.realtimeTurns;
  const turnsUsed = usage?.realtimeTurns;
  if (!Number.isSafeInteger(turnLimit) || turnLimit < 1
    || !Number.isSafeInteger(turnsUsed) || turnsUsed < 0) {
    return {
      kind: 'checking',
      title: 'Checking the isolated test…',
      message: 'Waiting for the local test status.',
      playback: '',
      note: '',
    };
  }

  if (turnsUsed < turnLimit) {
    const ttsRequests = usage.tts?.requests;
    const ttsLimit = limits.ttsRequests;
    const ttsCapped = Number.isSafeInteger(ttsRequests) && Number.isSafeInteger(ttsLimit)
      && ttsLimit > 0 && ttsRequests >= ttsLimit;
    return {
      kind: 'ready',
      title: 'Ready for one short test',
      message: 'Enable audio once, then hold P and release when you’re done.',
      playback: '',
      note: ttsCapped
        ? 'One Realtime turn is available. The provider TTS allowance is used; reply audio may use the browser fallback.'
        : 'One Realtime turn is available.',
    };
  }

  const turn = usage.lastTurn;
  if (!turn) {
    return {
      kind: 'pending',
      title: 'Test turn is resolving',
      message: 'The one-turn allowance is used. Waiting for the final result; no new turn can be started.',
      playback: '',
      note: 'This allowance will not reset automatically.',
    };
  }

  let message = 'The one-turn allowance was used, but completion status was not recorded.';
  if (turn?.status === 'authored_response_selected') {
    const intent = safeEnum(turn.playerIntent, /^[a-z_]{1,40}$/);
    const topic = safeEnum(turn.topic, /^[a-z_]{1,40}$/);
    message = intent && topic
      ? `Realtime selected an authored reply (${intent} · ${topic}).`
      : 'Realtime selected an authored reply.';
  } else if (turn?.status === 'authored_fallback') {
    message = 'Realtime completed without selecting an accepted authored reply. The fixture used its fixed greeting; semantic intent and topic were not confirmed.';
  }

  const tts = usage.tts ?? {};
  const succeeded = Number.isSafeInteger(tts.succeededRequests) ? tts.succeededRequests : 0;
  const failed = Number.isSafeInteger(tts.failedRequests) ? tts.failedRequests : 0;
  const unknown = Number.isSafeInteger(tts.outcomeUnknownRequests) ? tts.outcomeUnknownRequests : 0;
  const characters = Number.isSafeInteger(tts.characters) ? tts.characters : 0;
  const playback = unknown > 0
    ? 'Provider TTS outcome is unknown.'
    : failed > 0
      ? 'Provider TTS did not succeed. Check technical diagnostics for the safe delivery status.'
      : succeeded > 0
        ? `Provider TTS returned audio for ${characters} characters; playback is not confirmed by the server.`
        : 'No provider TTS request is recorded.';

  return {
    kind: 'complete',
    title: 'Test complete',
    message,
    playback,
    note: 'The one-turn allowance is used and will not reset automatically.',
  };
}
