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
    const priorTurn = usage.lastTurn;
    const priorIntent = safeEnum(priorTurn?.playerIntent, /^[a-z_]{1,40}$/);
    const priorTopic = safeEnum(priorTurn?.topic, /^[a-z_]{1,40}$/);
    const priorLineId = safeEnum(priorTurn?.lineId, /^[A-Za-z0-9:_-]{1,128}$/);
    const priorSummary = priorTurn?.status === 'authored_response_selected' && priorIntent && priorTopic && priorLineId
      ? `Previous selection: ${priorIntent} · ${priorTopic} · ${priorLineId}. `
      : priorTurn?.status === 'authored_fallback'
        ? 'Previous turn used the fixed local greeting; semantic selection was not confirmed. '
        : '';
    return {
      kind: 'ready',
      title: turnsUsed === 0 ? 'Ready for two short tests' : 'One short test remains',
      message: priorSummary + (turnsUsed === 0
        ? 'Enable audio once, then make two different requests with a separate hold and release for each.'
        : 'One turn is complete. Make a different request, then hold P and release when you’re done.'),
      playback: '',
      note: ttsCapped
        ? `${turnLimit - turnsUsed} Realtime turn${turnLimit - turnsUsed === 1 ? '' : 's'} available. The provider TTS allowance is used; reply audio may use the browser fallback.`
        : `${turnLimit - turnsUsed} Realtime turn${turnLimit - turnsUsed === 1 ? '' : 's'} available.`,
    };
  }

  const turn = usage.lastTurn;
  if (!turn) {
    return {
      kind: 'pending',
      title: 'Test turn is resolving',
      message: 'The two-turn allowance is used. Waiting for the final result; no new turn can be started.',
      playback: '',
      note: 'This allowance will not reset automatically.',
    };
  }

  let message = 'The two-turn allowance was used, but completion status was not recorded.';
  if (turn?.status === 'authored_response_selected') {
    const intent = safeEnum(turn.playerIntent, /^[a-z_]{1,40}$/);
    const topic = safeEnum(turn.topic, /^[a-z_]{1,40}$/);
    const lineId = safeEnum(turn.lineId, /^[A-Za-z0-9:_-]{1,128}$/);
    message = intent && topic && lineId
      ? `Realtime selected ${intent} · ${topic} · ${lineId}.`
      : 'Realtime selected an authored reply.';
  } else if (turn?.status === 'authored_fallback') {
    message = 'Realtime completed without selecting an accepted authored reply. The fixture used its fixed greeting; semantic intent and topic were not confirmed.';
  }

  const tts = usage.tts ?? {};
  const turnResults = Array.isArray(usage.turnResults) && usage.turnResults.length <= turnLimit
    ? usage.turnResults.map((result) => {
      const turnNumber = Number.isSafeInteger(result?.turnNumber) && result.turnNumber >= 1 && result.turnNumber <= turnLimit
        ? result.turnNumber : null;
      const intent = safeEnum(result?.playerIntent, /^[a-z_]{1,40}$/);
      const topic = safeEnum(result?.topic, /^[a-z_]{1,40}$/);
      const lineId = safeEnum(result?.lineId, /^[A-Za-z0-9:_-]{1,128}$/);
      if (!turnNumber || !lineId) return null;
      return result.status === 'authored_response_selected' && intent && topic
        ? `Turn ${turnNumber}: ${intent} · ${topic} · ${lineId}`
        : result.status === 'authored_fallback' ? `Turn ${turnNumber}: authored fallback · ${lineId}` : null;
    }).filter(Boolean)
    : [];
  if (turnResults.length > 0) message = `Completed results — ${turnResults.join('; ')}.`;
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
    note: 'The two-turn allowance is used and will not reset automatically.',
  };
}
