import {
  acquireNativeCapture, audioOutputTime, createNativeResponsePlayback, createRetryableWorkletLoader,
  decodePcm16Base64Chunk, encodePcm16, evaluateNativeAudioChunk, isNativeRealtimeSessionAck,
  NATIVE_REALTIME_RATE, pcmRemainderKey,
} from './audio/native-realtime-core.js';
import { NativeResidentPcmMixer } from './audio/native-resident-pcm-mixer.js';

const REALTIME_URL = 'wss://api.boson.ai/v1/realtime';
const MAX_OUTPUT_TRANSCRIPT_CHARS = 1_000;
const MAX_PENDING_PCM_REMAINDERS = 64;
const MAX_NATIVE_REACTION_SESSIONS = 4;
const MAX_NATIVE_REACTION_CONTEXT_BYTES = 2_000;

export class NativeResidentAudioClient {
  constructor({
    fetchImpl = globalThis.fetch,
    WebSocketClass = globalThis.WebSocket,
    AudioContextClass = globalThis.AudioContext,
    AudioWorkletNodeClass = globalThis.AudioWorkletNode,
    mediaDevices = globalThis.navigator?.mediaDevices,
    EventSourceClass = globalThis.EventSource,
    getPositionSocket = () => globalThis.window?.io?.(),
    enableInputTranscription = false,
    inputTranscriptionTimeoutMs = 8_000,
    onStatus = () => {},
  } = {}) {
    this.fetch = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
    this.WebSocket = WebSocketClass;
    this.AudioContext = AudioContextClass;
    this.AudioWorkletNode = AudioWorkletNodeClass;
    this.mediaDevices = mediaDevices;
    this.EventSource = EventSourceClass;
    this.getPositionSocket = getPositionSocket;
    this.enableInputTranscription = enableInputTranscription === true;
    this.inputTranscriptionTimeoutMs = Number.isFinite(inputTranscriptionTimeoutMs)
      ? Math.max(100, Math.min(30_000, inputTranscriptionTimeoutMs)) : 8_000;
    this.onStatus = onStatus;
    this.connections = new Map();
    this.residentPositions = new Map();
    this.listenerPosition = null;
    this.pendingPcmBytes = new Map();
    this.context = null;
    this.mixer = null;
    this.turn = null;
    this.held = false;
    this.heldGeneration = 0;
    this.holdSource = null;
    this.capture = null;
    this.captureGeneration = 0;
    this.workletLoader = null;
    this.failureStage = 'idle';
    this.started = false;
    this.destroyed = false;
    this.eventSource = null;
    this.positionSocket = null;
    this.removeUiListeners = [];
    this.nativeActivationId = null;
    this.nativeActivationPromise = null;
    this.nativeActivationNeedsRefresh = false;
  }

  start() {
    if (this.started || typeof document === 'undefined' || typeof window === 'undefined') return this;
    this.started = true;
    this.#mountControl();
    if (this.EventSource) {
      this.eventSource = new this.EventSource('/boson-residents');
      this.eventSource.addEventListener('residents', (event) => this.updateResidentPositions(event.data));
    }
    try {
      this.positionSocket = this.getPositionSocket();
      this.listenerPositionHandler = (packet) => this.updateListenerPosition(packet);
      this.positionSocket?.on?.('position', this.listenerPositionHandler);
    } catch { this.onStatus('position_unavailable'); }
    return this;
  }

  async beginHeldTurn(source = 'key') {
    if (this.destroyed) return;
    if (this.held) return;
    this.held = true;
    this.holdSource = source;
    const generation = ++this.heldGeneration;
    try {
      const activation = this.EventSource ? this.#activateNativeAudio() : null;
      this.failureStage = 'audio_context_create';
      await this.#ensureAudioContext();
      if (activation) await activation;
      if (!this.#isHeld(generation)) return;
      if (this.turn) {
        this.turn.pendingNewTurn = true;
        this.turn.released = true;
        this.#interruptOutput(this.turn.connection);
        this.#maybeEndTurn(this.turn);
        return;
      }
      await this.#beginTurn(generation);
    } catch (error) {
      this.#showSafeFailure(error, this.failureStage);
      this.#releaseHeldState();
    } finally {
      this.failureStage = 'idle';
    }
  }

  releaseHeldTurn() {
    if (!this.held) return;
    this.captureGeneration += 1;
    this.heldGeneration += 1;
    this.held = false;
    this.holdSource = null;
    const capture = this.capture;
    this.capture = null;
    this.#disconnectCapture(capture);
    const turn = this.turn;
    if (!turn) return;
    turn.released = true;
    if (!capture || turn.connection.socket.readyState !== this.WebSocket.OPEN) {
      this.onStatus('microphone_released');
      this.#maybeEndTurn(turn);
      return;
    }
    turn.waitingForCommit = true;
    turn.connection.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.onStatus('turn_finishing');
  }

  stop() {
    if (this.destroyed) return;
    const turn = this.turn;
    this.destroyed = true;
    const activationId = this.nativeActivationId;
    this.nativeActivationId = null;
    if (activationId) void this.#post('/boson-ptt/native-audio/deactivate', { activationId }).catch(() => undefined);
    this.releaseHeldTurn();
    this.eventSource?.close();
    this.positionSocket?.off?.('position', this.listenerPositionHandler);
    for (const remove of this.removeUiListeners) remove();
    this.removeUiListeners = [];
    if (turn) void this.#post('/boson-ptt/native/end', { turnId: turn.turnId, residentSessionId: turn.residentSessionId }).catch(() => undefined);
    for (const connection of this.connections.values()) {
      connection.reactionStream?.close?.();
      try { connection.socket.close(1000, 'viewer closed'); } catch { /* already closed */ }
    }
    this.connections.clear();
    this.mixer?.close();
    this.mixer = null;
    this.context = null;
  }

  async handleRealtimeEvent(connection, event) {
    if (this.connections.get(connection.residentSessionId) !== connection || !event || typeof event.type !== 'string') return;
    if (event.type === 'session.created' || event.type === 'session.updated') {
      if (!isNativeRealtimeSessionAck(event, connection.voice, this.enableInputTranscription)) throw new Error('session_config_mismatch');
      connection.ready = true;
      connection.resolveReady?.();
      connection.resolveReady = null;
      this.onStatus(`ready:${connection.speakerName}`);
      if (connection.turn && connection.turn === this.turn && this.#isHeld(connection.turn.generation)) await this.#startCapture(connection.turn);
      return;
    }
    if (event.type === 'input_audio_buffer.committed' && connection.turn?.waitingForCommit) {
      connection.turn.waitingForCommit = false;
      const inputItemId = safeProviderId(event.item_id);
      if (this.enableInputTranscription && inputItemId) this.#awaitInputTranscript(connection.turn, inputItemId);
      connection.turn.connection.socket.send(JSON.stringify({ type: 'response.create' }));
      connection.turn.responseInProgress = true;
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      if (!this.enableInputTranscription) return;
      await this.#receivePlayerTranscript(connection, event);
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      if (!this.enableInputTranscription) return;
      const itemId = safeProviderId(event.item_id);
      if (itemId && connection.turn) this.#clearInputTranscript(connection.turn, itemId);
      if (connection.turn) this.#maybeEndTurn(connection.turn);
      return;
    }
    if (event.type === 'response.created') {
      const responseId = safeProviderId(event.response?.id ?? event.response_id);
      if (!responseId) return;
      connection.playback.begin(responseId);
      connection.activeResponseId = responseId;
      connection.responseStates.set(responseId, { status: null });
      if (connection.activeReaction && !connection.turn) {
        connection.activeReaction.responseId = responseId;
        connection.reactionByResponse.set(responseId, connection.activeReaction.reactionId);
      } else if (connection.reactionInterruptResolve && connection.interruptedReactionId) {
        connection.reactionInterruptResponseId = responseId;
        connection.reactionByResponse.set(responseId, connection.interruptedReactionId);
      }
      return;
    }
    if (event.type === 'response.output_audio.delta') {
      if (connection.reactionInterruptResponseId === safeProviderId(event.response_id)) return;
      await this.#receivePcm(connection, event);
      return;
    }
    if (event.type === 'response.output_audio_transcript.delta' && typeof event.delta === 'string') {
      if (connection.reactionInterruptResponseId === safeProviderId(event.response_id)) return;
      const state = this.#responseItem(connection, event);
      state.transcript = appendBounded(state.transcript, event.delta, MAX_OUTPUT_TRANSCRIPT_CHARS);
      return;
    }
    if (event.type === 'response.output_audio_transcript.done' && typeof event.transcript === 'string') {
      const state = this.#responseItem(connection, event);
      state.transcript = event.transcript.slice(0, MAX_OUTPUT_TRANSCRIPT_CHARS);
      return;
    }
    if (event.type === 'response.done') {
      const responseId = safeProviderId(event.response?.id ?? event.response_id) ?? connection.activeResponseId;
      if (!responseId) return;
      const response = event.response && typeof event.response === 'object' ? event.response : {};
      const status = response.status === 'completed' ? 'completed' : 'interrupted';
      const responseState = connection.responseStates.get(responseId);
      if (responseState) responseState.status = status;
      this.#discardPcmRemainders(connection, responseId);
      if (connection.interruptionPending) this.#finalizeInterruption(connection, responseId);
      else connection.playback.finish(responseId);
      const responseItems = [...connection.outputItems.values()].filter((state) => state.responseId === responseId);
      await Promise.all(responseItems.map((state) => state.chain));
      for (const state of responseItems) {
        state.generationFinished = true;
        if (state.utteranceStarted) this.mixer?.finishUtterance(state.utteranceId);
      }
      const isReactionResponse = connection.reactionByResponse.has(responseId);
      if (isReactionResponse && responseItems.length === 0
        && connection.activeReaction?.responseId === responseId) connection.activeReaction = null;
      if (isReactionResponse && responseItems.length === 0) connection.reactionByResponse.delete(responseId);
      if (connection.activeResponseId === responseId) connection.activeResponseId = null;
      if (connection.turn && !isReactionResponse) connection.turn.responseInProgress = false;
      this.onStatus(status === 'completed' ? 'reply_playing' : 'reply_interrupted');
      if (connection.reactionInterruptResolve
        && (!connection.reactionInterruptResponseId || connection.reactionInterruptResponseId === responseId)) {
        this.#resolveReactionInterrupt(connection);
      }
      if (connection.turn && !isReactionResponse) this.#maybeEndTurn(connection.turn);
      return;
    }
    if (event.type === 'error') {
      const code = safeCode(event.error?.code);
      if (code === 'response_cancel_not_active' && connection.reactionInterruptResolve) {
        this.#resolveReactionInterrupt(connection);
        return;
      }
      if (code === 'response_cancel_not_active' && connection.interruptionPending) {
        this.#finalizeInterruption(connection, connection.interruptionPending.responseId);
        return;
      }
      throw new Error(code);
    }
  }

  async #activateNativeAudio() {
    if (this.turn) return;
    if (this.nativeActivationId && !this.nativeActivationNeedsRefresh) return;
    if (this.nativeActivationPromise) return this.nativeActivationPromise;
    if (this.nativeActivationId && this.nativeActivationNeedsRefresh) await this.#retireNativeActivation();
    this.nativeActivationPromise = this.#performNativeActivation();
    try { await this.nativeActivationPromise; }
    finally { this.nativeActivationPromise = null; }
  }

  async #retireNativeActivation() {
    const activationId = this.nativeActivationId;
    this.nativeActivationId = null;
    this.nativeActivationNeedsRefresh = false;
    for (const [sessionId, connection] of this.connections) {
      if (!connection.activationSession) continue;
      connection.reactionStream?.close?.();
      try { connection.socket.close(1000, 'native activation refreshed'); } catch { /* already closed */ }
      this.connections.delete(sessionId);
    }
    if (activationId) await this.#post('/boson-ptt/native-audio/deactivate', { activationId }).catch(() => undefined);
  }

  async #performNativeActivation() {
    try {
      let activation;
      try { activation = await this.#post('/boson-ptt/native-audio/activate', {}); }
      catch (error) {
        if (!isRetryableActivationFailure(error)) throw error;
        activation = await this.#post('/boson-ptt/native-audio/activate', {});
      }
      if (activation?.available !== true || !safeProviderId(activation.activationId)
        || !Array.isArray(activation.sessions) || activation.sessions.length > MAX_NATIVE_REACTION_SESSIONS) return;
      this.nativeActivationId = activation.activationId;
      this.nativeActivationNeedsRefresh = false;
      const seenSessionIds = new Set();
      if (activation.sessions.length === 0) this.nativeActivationNeedsRefresh = true;
      for (const session of activation.sessions) {
        if (this.destroyed) break;
        if (!isNativeReactionSession(session) || seenSessionIds.has(session.residentSessionId)) {
          this.nativeActivationNeedsRefresh = true;
          continue;
        }
        seenSessionIds.add(session.residentSessionId);
        try { await this.#openReactionSession(session); }
        catch {
          const failedConnection = this.connections.get(session.residentSessionId);
          if (failedConnection) {
            failedConnection.reactionStream?.close?.();
            try { failedConnection.socket.close(1000, 'reaction setup failed'); } catch { /* already closed */ }
            this.connections.delete(session.residentSessionId);
          }
          this.nativeActivationNeedsRefresh = true;
          this.onStatus('reaction_session_unavailable');
        }
      }
      if (this.destroyed && this.nativeActivationId) {
        const activationId = this.nativeActivationId;
        this.nativeActivationId = null;
        await this.#post('/boson-ptt/native-audio/deactivate', { activationId }).catch(() => undefined);
      }
    } catch {
      this.onStatus('reaction_activation_unavailable');
      if (this.nativeActivationId) {
        const activationId = this.nativeActivationId;
        this.nativeActivationId = null;
        await this.#post('/boson-ptt/native-audio/deactivate', { activationId }).catch(() => undefined);
      }
    }
  }

  async #openReactionSession(session) {
    const voice = session.voice;
    let clientSecret = session.shortLivedCredential;
    const socket = new this.WebSocket(REALTIME_URL, ['realtime', `bai-client-secret.${clientSecret}`]);
    clientSecret = '';
    session.shortLivedCredential = '';
    const connection = {
      residentSessionId: session.residentSessionId, residentId: session.residentId,
      speakerName: session.speakerName, voice, pendingBegin: null, activationInstructions: session.instructions,
      activationSession: true,
      socket, ready: false, turn: null, playback: createNativeResponsePlayback(), activeResponseId: null,
      interruptionPending: null, outputItems: new Map(), responseStates: new Map(),
      pendingByteMap: new Map(), reactionStream: null, activeReaction: null, reactionByResponse: new Map(),
    };
    this.connections.set(session.residentSessionId, connection);
    connection.readyPromise = new Promise((resolve, reject) => {
      connection.resolveReady = resolve;
      connection.rejectReady = reject;
      socket.addEventListener('open', () => {
        if (this.connections.get(session.residentSessionId) !== connection) return;
        socket.send(JSON.stringify({ type: 'session.update', session: createSessionConfig(connection.activationInstructions, voice) }));
      });
      socket.addEventListener('message', (message) => {
        if (typeof message.data !== 'string') return;
        try { void this.handleRealtimeEvent(connection, JSON.parse(message.data)).catch((error) => this.#failConnection(connection, failureCodeFromError(error))); }
        catch { this.onStatus('provider_event_invalid'); }
      });
      socket.addEventListener('error', () => this.#failConnection(connection, 'provider_connection_failed'));
      socket.addEventListener('close', () => this.#failConnection(connection, 'provider_connection_closed'));
    });
    const timer = setTimeout(() => connection.rejectReady?.(new Error('session_ack_timeout')), 15_000);
    try { await connection.readyPromise; }
    catch (error) {
      connection.failed = true;
      this.connections.delete(session.residentSessionId);
      try { socket.close(1000, 'native setup failed'); } catch { /* already closed */ }
      throw error;
    } finally { clearTimeout(timer); }
    if (this.destroyed) { socket.close(1000, 'viewer closed'); return; }
    this.residentPositions.set(session.residentId, { ...session.position });
    this.mixer?.setSpeakerPosition(session.residentId, session.position);
    const stream = new this.EventSource(session.reactionStream);
    connection.reactionStream = stream;
    stream.addEventListener('native-reaction', (event) => {
      let dispatch;
      try { dispatch = JSON.parse(event.data); } catch { return; }
      void this.#dispatchNativeReaction(connection, dispatch);
    });
    stream.addEventListener('error', () => this.onStatus('reaction_stream_reconnecting'));
  }

  async #dispatchNativeReaction(connection, dispatch) {
    if (!safeProviderId(dispatch?.reactionId)) return;
    const valid = this.connections.get(connection.residentSessionId) === connection && isNativeReactionDispatch(dispatch)
      && dispatch.residentId === connection.residentId && dispatch.causalDepth < 2;
    const status = !valid || dispatch.expiresAt <= Date.now() ? 'unavailable'
      : (connection.turn || connection.activeReaction || connection.failed || !connection.ready ? 'busy' : 'accepted');
    if (valid && status === 'accepted') connection.activeReaction = { ...dispatch, responseId: null, outputCount: 0 };
    try {
      const acknowledgement = await this.#post('/boson-ptt/reaction/ack', {
        reactionId: safeProviderId(dispatch?.reactionId) ? dispatch.reactionId : 'invalid',
        residentSessionId: connection.residentSessionId, status,
      });
      if (status === 'accepted' && (acknowledgement?.accepted !== true || acknowledgement?.status !== 'accepted')) {
        if (connection.activeReaction?.reactionId === dispatch?.reactionId) connection.activeReaction = null;
        return;
      }
    } catch {
      if (connection.activeReaction?.reactionId === dispatch?.reactionId) connection.activeReaction = null;
      return;
    }
    if (status !== 'accepted' || !connection.activeReaction || connection.activeReaction.reactionId !== dispatch.reactionId) return;
    const text = `You are ${connection.speakerName}. You heard this attributed, unverified context: ${dispatch.context}. Reply naturally in one brief spoken line. Do not claim to perform actions.`;
    connection.socket.send(JSON.stringify({ type: 'conversation.item.create', item: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text }],
    } }));
    connection.activeReaction.responseRequested = true;
    connection.socket.send(JSON.stringify({ type: 'response.create' }));
  }

  async #ensureAudioContext() {
    if (!this.AudioContext || !this.WebSocket || !this.AudioWorkletNode) throw new Error('audio_unavailable');
    if (!this.context) {
      this.failureStage = 'audio_context_create';
      this.context = new this.AudioContext({ sampleRate: NATIVE_REALTIME_RATE });
      this.mixer = new NativeResidentPcmMixer({ context: this.context, onState: (event) => this.#mixerState(event) });
      if (this.listenerPosition) this.mixer.setListenerPosition(this.listenerPosition);
      for (const [residentId, position] of this.residentPositions) this.mixer.setSpeakerPosition(residentId, position);
      this.workletLoader = createRetryableWorkletLoader(() => this.context.audioWorklet.addModule('/boson-ptt-worklet.js'));
    }
    this.failureStage = 'audio_context_resume';
    await this.context.resume();
  }

  async #beginTurn(generation) {
    if (!this.#isHeld(generation)) return;
    this.onStatus('connecting');
    this.failureStage = 'native_begin';
    const begin = await this.#post('/boson-ptt/native/begin', {
      knownResidentSessionIds: [...this.connections.keys()].slice(-8),
    });
    validateBegin(begin);
    if (!this.#isHeld(generation)) {
      await this.#post('/boson-ptt/native/end', { turnId: begin.turnId, residentSessionId: begin.residentSessionId }).catch(() => undefined);
      return;
    }
    let connection = this.connections.get(begin.residentSessionId);
    if (begin.reuseSession && !connection) throw new Error('resident_session_unavailable');
    if (!connection) {
      try { connection = await this.#createConnection(begin, generation); }
      catch (error) {
        await this.#post('/boson-ptt/native/end', { turnId: begin.turnId, residentSessionId: begin.residentSessionId }).catch(() => undefined);
        throw error;
      }
    }
    if (!connection) return;
    if (connection.activeReaction) await this.#interruptReaction(connection);
    connection.turn = { ...begin, connection, generation, released: false, pendingNewTurn: false,
      waitingForCommit: false, responseInProgress: false, pendingInputTranscriptions: new Set(),
      pendingInputSpeechAcks: 0, inputTranscriptionTimers: new Map() };
    if (!this.#isHeld(generation)) connection.turn.released = true;
    this.turn = connection.turn;
    if (begin.reuseSession && connection.ready) {
      connection.turn = this.turn;
      connection.socket.send(JSON.stringify({ type: 'session.update', session: createSessionConfig(begin.instructions, begin.voice, this.enableInputTranscription) }));
      if (!this.#isHeld(generation)) { this.releaseHeldTurn(); return; }
    } else if (connection.ready && this.#isHeld(generation)) {
      await this.#startCapture(this.turn);
    }
    if (connection.turn.released) {
      this.#maybeEndTurn(connection.turn);
    }
  }

  async #createConnection(begin, generation) {
    this.failureStage = 'native_credential';
    const credential = await this.#post('/boson-ptt/native/credential', {
      turnId: begin.turnId, residentSessionId: begin.residentSessionId,
    });
    if (!credential.available || typeof credential.clientSecret !== 'string' || !credential.clientSecret.startsWith('bai-eph-')) {
      throw new Error('credential_unavailable');
    }
    if (!this.#isHeld(generation)) {
      await this.#post('/boson-ptt/native/end', { turnId: begin.turnId, residentSessionId: begin.residentSessionId }).catch(() => undefined);
      return null;
    }
    this.failureStage = 'realtime_websocket';
    const socket = new this.WebSocket(REALTIME_URL, ['realtime', `bai-client-secret.${credential.clientSecret}`]);
    credential.clientSecret = '';
    const connection = {
      residentSessionId: begin.residentSessionId, residentId: begin.residentId, speakerName: begin.speakerName, voice: begin.voice,
      pendingBegin: begin,
      socket, ready: false, turn: null, playback: createNativeResponsePlayback(), activeResponseId: null,
      interruptionPending: null, outputItems: new Map(), responseStates: new Map(),
      pendingByteMap: new Map(), reactionStream: null, activeReaction: null, reactionByResponse: new Map(),
    };
    this.connections.set(begin.residentSessionId, connection);
    connection.readyPromise = new Promise((resolve, reject) => {
      connection.resolveReady = resolve;
      connection.rejectReady = reject;
      socket.addEventListener('open', () => {
        if (this.connections.get(begin.residentSessionId) !== connection) return;
        socket.send(JSON.stringify({ type: 'session.update', session: createSessionConfig(begin.instructions, begin.voice, this.enableInputTranscription) }));
      });
      socket.addEventListener('message', (message) => {
        if (typeof message.data !== 'string') return;
        try { void this.handleRealtimeEvent(connection, JSON.parse(message.data)).catch((error) => this.#failConnection(connection, failureCodeFromError(error))); }
        catch { this.onStatus('provider_event_invalid'); }
      });
      socket.addEventListener('error', () => this.#failConnection(connection, 'provider_connection_failed'));
      socket.addEventListener('close', () => this.#failConnection(connection, 'provider_connection_closed'));
    });
    const timer = setTimeout(() => connection.rejectReady?.(new Error('session_ack_timeout')), 15_000);
    this.failureStage = 'realtime_session_ack';
    try { await connection.readyPromise; }
    catch (error) {
      connection.failed = true;
      this.connections.delete(begin.residentSessionId);
      try { socket.close(1000, 'native setup failed'); } catch { /* already closed */ }
      throw error;
    } finally { clearTimeout(timer); }
    connection.turn = this.turn;
    return connection;
  }

  async #startCapture(turn) {
    if (!this.#isHeld(turn.generation) || turn.connection !== this.turn?.connection) return;
    this.failureStage = 'microphone_capture';
    const generation = ++this.captureGeneration;
    const isCurrent = () => this.#isHeld(turn.generation) && this.captureGeneration === generation
      && this.turn?.connection === turn.connection;
    const result = await acquireNativeCapture({
      isCurrent,
      getUserMedia: () => {
        if (!this.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'NotSupportedError' });
        return this.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      },
      resumeContext: () => this.context.resume(),
      prepareWorklet: this.workletLoader,
      createCapture: (stream) => {
        const source = this.context.createMediaStreamSource(stream);
        let node;
        try {
          node = new this.AudioWorkletNode(this.context, 'boson-ptt-capture', { processorOptions: { targetSampleRate: NATIVE_REALTIME_RATE } });
          node.port.onmessage = (event) => {
            const samples = event.data;
            if (!isCurrent() || !(samples instanceof Float32Array) || samples.length === 0) return;
            turn.connection.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: encodePcm16(samples) }));
            turn.inputSamples = (turn.inputSamples ?? 0) + samples.length;
          };
          source.connect(node); node.connect(this.context.destination);
          return { stream, source, node };
        } catch (error) { this.#disconnectCapture({ source, node }); throw error; }
      },
      stopStream: (stream) => this.#stopStream(stream),
      disconnectCapture: (capture) => this.#disconnectCapture(capture),
    });
    if (!isCurrent()) return;
    this.failureStage = 'idle';
    if (!result.capture) {
      turn.finalStatus = result.reason ?? 'microphone_unavailable';
      this.releaseHeldTurn();
      return;
    }
    this.capture = result.capture;
    this.onStatus('listening');
  }

  async #receivePcm(connection, event) {
    if (connection.failed) return;
    const responseId = safeProviderId(event.response_id) ?? connection.activeResponseId;
    const itemId = safeProviderId(event.item_id);
    if (!responseId || !itemId || !connection.playback.acceptsAudio(responseId)) return;
    const contentIndex = Number.isSafeInteger(event.content_index) && event.content_index >= 0 ? event.content_index : 0;
    const key = pcmRemainderKey(responseId, itemId, contentIndex);
    const decoded = decodePcm16Base64Chunk(event.delta, connection.pendingByteMap.get(key)?.byte ?? null);
    if (!decoded.valid) throw new Error(`invalid_pcm_${decoded.reason}`);
    if (decoded.pendingByte === null) connection.pendingByteMap.delete(key);
    else {
      if (!connection.pendingByteMap.has(key) && connection.pendingByteMap.size >= MAX_PENDING_PCM_REMAINDERS) throw new Error('pcm_fragment_limit');
      connection.pendingByteMap.set(key, { byte: decoded.pendingByte, responseId });
    }
    if (!decoded.samples.length) return;
    const decision = evaluateNativeAudioChunk({ hasContext: Boolean(this.context), responseAccepted: true, samples: decoded.samples,
      responseSeconds: connection.responseStates.get(responseId)?.outputSeconds ?? 0,
      queuedSeconds: this.mixer.queuedSeconds });
    if (!decision.accepted) throw new Error(decision.reason);
    const utteranceId = JSON.stringify([responseId, itemId, contentIndex]);
    let item = connection.outputItems.get(utteranceId);
    if (!item) {
      item = { utteranceId, responseId, itemId, contentIndex, transcript: '', chain: Promise.resolve(),
        utteranceStarted: false, generationFinished: false, speechStarted: false,
        reactionId: connection.reactionByResponse.get(responseId)
          ?? (connection.activeReaction && !connection.turn ? connection.activeReaction.reactionId : null) };
      connection.outputItems.set(utteranceId, item);
    }
    const responseState = connection.responseStates.get(responseId) ?? { status: null, outputSeconds: 0 };
    responseState.outputSeconds = (responseState.outputSeconds ?? 0) + decision.duration;
    connection.responseStates.set(responseId, responseState);
    item.chain = item.chain.then(async () => {
      if (!item.speechStarted) {
        if (item.reactionId) {
          const started = await this.#post('/boson-ptt/reaction/speech/start', {
            reactionId: item.reactionId, residentSessionId: connection.residentSessionId, responseId, itemId,
          });
          if (started?.accepted !== true || started?.status !== 'started') throw new Error('reaction_start_rejected');
        } else await this.#post('/boson-ptt/speech/start', {
          turnId: connection.turn?.turnId, residentSessionId: connection.residentSessionId, responseId, itemId,
        });
        item.speechStarted = true;
        if (item.reactionId && connection.activeReaction?.reactionId === item.reactionId) connection.activeReaction.outputCount += 1;
        if (connection.failed || item.interrupted) return;
        item.utteranceStarted = this.mixer.startUtterance({ speakerId: connection.residentId, utteranceId });
      }
      const accepted = this.mixer.enqueue({ speakerId: connection.residentId, utteranceId, samples: decoded.samples });
      if (!accepted) throw new Error('spatial_audio_queue_full');
      const position = this.residentPositions.get(connection.residentId);
      if (!position) throw new Error('resident_position_unavailable');
      this.mixer.setSpeakerPosition(connection.residentId, position);
      const source = this.mixer.utterances.get(utteranceId)?.sources;
      const lastSource = source ? [...source].at(-1) : null;
      if (lastSource) connection.playback.addChunk(responseId, { itemId, contentIndex, startAt: lastSource.startAt, duration: decision.duration });
      if (item.generationFinished) this.mixer.finishUtterance(item.utteranceId);
    });
    await item.chain;
  }

  async #receivePlayerTranscript(connection, event) {
    const turn = connection.turn;
    const itemId = safeProviderId(event.item_id);
    const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : '';
    if (!turn || !itemId || !turn.pendingInputTranscriptions.has(itemId)) return;
    if (!transcript || transcript.length > MAX_OUTPUT_TRANSCRIPT_CHARS || utf8Length(transcript) > 1_000) {
      this.#clearInputTranscript(turn, itemId);
      this.onStatus('player_transcript_unavailable');
      this.#maybeEndTurn(turn);
      return;
    }
    turn.pendingInputSpeechAcks += 1;
    try {
      await this.#post('/boson-ptt/player-speech/finish', {
        turnId: turn.turnId, residentSessionId: turn.residentSessionId, itemId, transcript,
      });
    } catch { this.onStatus('player_transcript_failed'); }
    finally {
      this.#clearInputTranscript(turn, itemId);
      turn.pendingInputSpeechAcks = Math.max(0, turn.pendingInputSpeechAcks - 1);
      this.#maybeEndTurn(turn);
    }
  }

  #awaitInputTranscript(turn, itemId) {
    turn.pendingInputTranscriptions.add(itemId);
    const timer = setTimeout(() => {
      this.#clearInputTranscript(turn, itemId);
      this.onStatus('player_transcript_timeout');
      this.#maybeEndTurn(turn);
    }, this.inputTranscriptionTimeoutMs);
    turn.inputTranscriptionTimers.set(itemId, timer);
  }

  #clearInputTranscript(turn, itemId) {
    turn.pendingInputTranscriptions.delete(itemId);
    const timer = turn.inputTranscriptionTimers.get(itemId);
    if (timer) clearTimeout(timer);
    turn.inputTranscriptionTimers.delete(itemId);
  }

  #responseItem(connection, event) {
    const responseId = safeProviderId(event.response_id) ?? connection.activeResponseId ?? 'response-unknown';
    const itemId = safeProviderId(event.item_id) ?? 'item-unknown';
    const contentIndex = Number.isSafeInteger(event.content_index) && event.content_index >= 0 ? event.content_index : 0;
    const utteranceId = JSON.stringify([responseId, itemId, contentIndex]);
    let item = connection.outputItems.get(utteranceId);
    if (!item) {
      item = { utteranceId, responseId, itemId, contentIndex, transcript: '', chain: Promise.resolve(),
        utteranceStarted: false, generationFinished: false, speechStarted: false,
        reactionId: connection.reactionByResponse.get(responseId)
          ?? (connection.activeReaction && !connection.turn ? connection.activeReaction.reactionId : null) };
      connection.outputItems.set(utteranceId, item);
    }
    return item;
  }

  #mixerState(event) {
    if (event.type !== 'utterance-end') return;
    const connection = [...this.connections.values()].find((candidate) => candidate.outputItems.has(event.utteranceId));
    const item = connection?.outputItems.get(event.utteranceId);
    if (!connection || !item) return;
    const responseStatus = connection.responseStates.get(item.responseId)?.status;
    const completed = event.playback === 'completed' && responseStatus === 'completed'
      && Boolean(item.transcript.trim()) && item.transcript.length <= MAX_OUTPUT_TRANSCRIPT_CHARS;
    void this.#finishSpeechItem(connection, item, completed ? 'completed' : 'interrupted');
  }

  #finishSpeechItem(connection, item, playback) {
    if (item.finishing) return;
    item.finishing = true;
    if (item.reactionId) {
      if (!item.speechStarted) {
        connection.outputItems.delete(item.utteranceId);
        return Promise.resolve();
      }
      const transcript = item.transcript.trim();
      const completed = playback === 'completed' && transcript.length > 0;
      return this.#post('/boson-ptt/reaction/speech/finish', {
        reactionId: item.reactionId, residentSessionId: connection.residentSessionId,
        responseId: item.responseId, itemId: item.itemId, playback: completed ? 'completed' : 'interrupted',
        ...(completed ? { transcript } : {}),
      }).catch(() => this.onStatus('reaction_finish_failed')).finally(() => {
        connection.outputItems.delete(item.utteranceId);
        if (![...connection.outputItems.values()].some((output) => output.reactionId === item.reactionId)) {
          if (connection.activeReaction?.reactionId === item.reactionId) connection.activeReaction = null;
          connection.reactionByResponse.delete(item.responseId);
        }
      });
    }
    const turnId = connection.turn?.turnId;
    if (!item.speechStarted || !turnId) {
      connection.outputItems.delete(item.utteranceId);
      if (connection.turn) this.#maybeEndTurn(connection.turn);
      return Promise.resolve();
    }
    const transcript = item.transcript.trim();
    const completed = playback === 'completed' && transcript.length > 0;
    return this.#post('/boson-ptt/speech/finish', {
      turnId, residentSessionId: connection.residentSessionId, responseId: item.responseId, itemId: item.itemId,
      playback: completed ? 'completed' : 'interrupted',
      ...(completed ? { transcript } : {}),
    }).catch(() => this.onStatus('speech_finish_failed')).finally(() => {
      connection.outputItems.delete(item.utteranceId);
      if (connection.turn) this.#maybeEndTurn(connection.turn);
    });
  }

  #interruptOutput(connection) {
    const activeResponseId = connection.activeResponseId;
    const reactionResponsePending = connection.activeReaction?.responseRequested === true
      && (!connection.activeReaction.responseId || connection.responseStates.get(connection.activeReaction.responseId)?.status === null);
    const interruption = connection.playback.interrupt(audioOutputTime(this.context));
    this.#discardPcmRemainders(connection, interruption?.responseId ?? activeResponseId);
    if (!interruption) {
      if ((connection.turn?.responseInProgress || reactionResponsePending) && connection.socket.readyState === this.WebSocket.OPEN) {
        connection.socket.send(JSON.stringify({ type: 'response.cancel' }));
      }
      for (const item of connection.outputItems.values()) this.mixer?.stopUtterance(item.utteranceId);
      return;
    }
    for (const item of connection.outputItems.values()) this.mixer?.stopUtterance(item.utteranceId);
    if (interruption.cancel) {
      connection.interruptionPending = { responseId: interruption.responseId };
      if (connection.socket.readyState === this.WebSocket.OPEN) connection.socket.send(JSON.stringify({ type: 'response.cancel' }));
    } else if (interruption.truncate) {
      if (connection.socket.readyState === this.WebSocket.OPEN) connection.socket.send(JSON.stringify(interruption.truncate));
      connection.playback.clear(interruption.responseId);
      if (reactionResponsePending && connection.socket.readyState === this.WebSocket.OPEN) {
        connection.socket.send(JSON.stringify({ type: 'response.cancel' }));
      }
    }
  }

  async #interruptReaction(connection) {
    const reaction = connection.activeReaction;
    if (!reaction) return;
    const responsePending = reaction.responseRequested
      && (!reaction.responseId || connection.responseStates.get(reaction.responseId)?.status === null);
    this.#interruptOutput(connection);
    for (const item of connection.outputItems.values()) this.mixer?.stopUtterance(item.utteranceId);
    connection.activeReaction = null;
    if (responsePending && connection.socket.readyState === this.WebSocket.OPEN) {
      connection.interruptedReactionId = reaction.reactionId;
      await new Promise((resolve) => {
        connection.reactionInterruptResolve = resolve;
        connection.reactionInterruptTimer = setTimeout(() => this.#resolveReactionInterrupt(connection), 1_000);
      });
    }
  }

  #resolveReactionInterrupt(connection) {
    if (!connection.reactionInterruptResolve) return;
    clearTimeout(connection.reactionInterruptTimer);
    connection.reactionInterruptTimer = null;
    connection.reactionInterruptResolve();
    connection.reactionInterruptResolve = null;
    connection.interruptedReactionId = null;
    connection.reactionInterruptResponseId = null;
  }

  #finalizeInterruption(connection, responseId) {
    const pending = connection.interruptionPending;
    if (!pending || (pending.responseId && pending.responseId !== responseId)) return;
    const result = connection.playback.finish(responseId);
    if (result?.truncate) connection.socket.send(JSON.stringify(result.truncate));
    if (pending.responseId) connection.playback.clear(pending.responseId);
    connection.interruptionPending = null;
  }

  #discardPcmRemainders(connection, responseId) {
    for (const [key, remainder] of connection.pendingByteMap) {
      if (!responseId || remainder.responseId === responseId) connection.pendingByteMap.delete(key);
    }
  }

  #maybeEndTurn(turn) {
    if (this.turn !== turn || turn.ending || !turn.released || turn.responseInProgress
      || turn.connection.outputItems.size || turn.pendingInputTranscriptions.size || turn.pendingInputSpeechAcks > 0) return;
    turn.ending = true;
    void this.#post('/boson-ptt/native/end', { turnId: turn.turnId, residentSessionId: turn.residentSessionId })
      .catch(() => this.onStatus('conversation_end_failed'))
      .finally(() => {
        if (this.turn !== turn) return;
        this.turn = null;
        for (const timer of turn.inputTranscriptionTimers.values()) clearTimeout(timer);
        turn.inputTranscriptionTimers.clear();
        turn.connection.turn = null;
        turn.connection.playback.reset();
        if (turn.pendingNewTurn && this.held) void this.#beginTurn(this.heldGeneration).catch((error) => {
          this.#showSafeFailure(error); this.#releaseHeldState();
        });
        else this.onStatus(turn.finalStatus ?? 'ready');
      });
  }

  updateResidentPositions(raw) {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (event?.type !== 'village.residents' || !Array.isArray(event.residents)) return;
    for (const resident of event.residents) {
      if (typeof resident?.residentId !== 'string' || !validPosition(resident.position)) continue;
      const position = { ...resident.position };
      this.residentPositions.set(resident.residentId, position);
      this.mixer?.setSpeakerPosition(resident.residentId, position);
    }
  }

  updateListenerPosition(packet) {
    const position = packet?.pos ?? packet?.position;
    if (!validPosition(position)) return;
    this.listenerPosition = { x: position.x, y: position.y, z: position.z,
      ...(Number.isFinite(packet.yaw) ? { yaw: packet.yaw } : {}) };
    this.mixer?.setListenerPosition(this.listenerPosition);
  }

  async #post(path, body) {
    const response = await this.fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      ...(path === '/boson-ptt/native-audio/deactivate' ? { keepalive: true } : {}) });
    let value;
    try { value = await response.json(); }
    catch {
      if (response.ok) throw new Error('invalid_json_response');
      value = {};
    }
    if (!response.ok) throw new Error(structuredPttFailure(path, response.status, value));
    return value;
  }

  #failConnection(connection, code) {
    if (connection.failed) return;
    connection.rejectReady?.(new Error(code));
    if (connection.turn) this.#interruptOutput(connection);
    connection.failed = true;
    connection.reactionStream?.close?.();
    this.#resolveReactionInterrupt(connection);
    if (connection.activationSession) this.nativeActivationNeedsRefresh = true;
    if (connection.activeReaction) connection.activeReaction = null;
    try { connection.socket.close(1011, 'resident session failed'); } catch { /* already closed */ }
    const turn = connection.turn;
    if (this.held) {
      this.held = false;
      this.holdSource = null;
      this.captureGeneration += 1;
      this.heldGeneration += 1;
      const capture = this.capture;
      this.capture = null;
      this.#disconnectCapture(capture);
    }
    if (turn) {
      turn.released = true;
      turn.waitingForCommit = false;
      turn.responseInProgress = false;
    }
    for (const item of [...connection.outputItems.values()]) {
      item.interrupted = true;
      this.mixer?.stopUtterance(item.utteranceId);
      item.generationFinished = true;
      if (!item.utteranceStarted) {
        void item.chain.then(() => this.#finishSpeechItem(connection, item, 'interrupted'),
          () => this.#finishSpeechItem(connection, item, 'interrupted'));
      } else void this.#finishSpeechItem(connection, item, 'interrupted');
    }
    if (turn) this.#maybeEndTurn(turn);
    if (this.connections.get(connection.residentSessionId) === connection) this.connections.delete(connection.residentSessionId);
    this.onStatus(code);
  }

  #showSafeFailure(error, stage = 'unknown') {
    const code = safeCode(error instanceof Error ? error.message : '');
    if (code === 'no_nearby_resident' || /^native_(?:begin|credential)_http_[1-5]\d\d$/.test(code)) {
      this.onStatus(code);
      return;
    }
    const safeStage = SAFE_FAILURE_STAGES.has(stage) ? stage : 'unknown';
    if (SAFE_INTERNAL_FAILURES.has(code)) {
      this.onStatus(`${safeStage}_${code}`);
      return;
    }
    const exception = safeExceptionName(error).toLowerCase();
    this.onStatus(`startup_${safeStage}_${exception}`);
  }

  #isHeld(generation) { return this.held && !this.destroyed && this.heldGeneration === generation; }

  #releaseHeldState() {
    this.held = false;
    this.holdSource = null;
    this.captureGeneration += 1;
    this.heldGeneration += 1;
  }

  #stopStream(stream) {
    for (const track of stream?.getTracks?.() ?? []) { try { track.stop(); } catch { /* track already stopped */ } }
  }

  #disconnectCapture(capture) {
    if (!capture) return;
    if (capture.node?.port) capture.node.port.onmessage = null;
    try { capture.node?.disconnect(); } catch { /* already disconnected */ }
    try { capture.source?.disconnect(); } catch { /* already disconnected */ }
    this.#stopStream(capture.stream);
  }

  #mountControl() {
    const panel = document.createElement('section');
    panel.id = 'boson-native-ptt';
    panel.setAttribute('aria-label', 'Talk to a nearby villager');
    panel.innerHTML = '<button type="button" aria-pressed="false">Talk to a nearby villager <span>Hold P to talk</span></button><small role="status" aria-live="polite">Ready</small>';
    Object.assign(panel.style, { position: 'fixed', zIndex: '8', left: '16px', bottom: '16px', color: '#f8fafc',
      background: 'rgba(15,23,42,.94)', border: '1px solid rgba(148,163,184,.55)', borderRadius: '9px', padding: '8px 10px', font: '14px/1.35 system-ui,sans-serif' });
    const button = panel.querySelector('button');
    const status = panel.querySelector('small');
    Object.assign(button.style, { color: 'inherit', background: '#334155', border: '1px solid #64748b', borderRadius: '6px', padding: '7px 9px', font: 'inherit', cursor: 'pointer' });
    Object.assign(status.style, { display: 'block', minHeight: '1em', marginTop: '3px' });
    document.body.append(panel);
    this.panel = panel;
    this.onStatus = (value) => {
      status.textContent = statusText(value);
      button.setAttribute('aria-pressed', String(this.held));
    };
    const down = (event) => {
      if (button.disabled || this.held) return;
      event.preventDefault();
      this.pointerId = event.pointerId;
      if (event.pointerId !== undefined) { try { button.setPointerCapture(event.pointerId); } catch { /* optional */ } }
      void this.beginHeldTurn('pointer');
    };
    const up = (event) => {
      if (this.holdSource === 'pointer' && (event.pointerId === undefined || event.pointerId === this.pointerId)) {
        event.preventDefault(); this.pointerId = undefined; this.releaseHeldTurn();
      }
    };
    const keydown = (event) => {
      if (event.code !== 'KeyP' || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || isEditable(event.target) || this.held || document.visibilityState !== 'visible') return;
      event.preventDefault(); void this.beginHeldTurn('key');
    };
    const keyup = (event) => { if (event.code === 'KeyP' && this.holdSource === 'key') { event.preventDefault(); this.releaseHeldTurn(); } };
    const blur = () => this.releaseHeldTurn();
    const visibility = () => { if (document.visibilityState !== 'visible') this.releaseHeldTurn(); };
    button.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    button.addEventListener('lostpointercapture', up);
    document.addEventListener('keydown', keydown);
    document.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    const pagehide = () => this.stop();
    window.addEventListener('pagehide', pagehide, { once: true });
    this.removeUiListeners.push(() => button.removeEventListener('pointerdown', down));
    this.removeUiListeners.push(() => window.removeEventListener('pointerup', up, true));
    this.removeUiListeners.push(() => window.removeEventListener('pointercancel', up, true));
    this.removeUiListeners.push(() => button.removeEventListener('lostpointercapture', up));
    this.removeUiListeners.push(() => document.removeEventListener('keydown', keydown));
    this.removeUiListeners.push(() => document.removeEventListener('keyup', keyup));
    this.removeUiListeners.push(() => window.removeEventListener('blur', blur));
    this.removeUiListeners.push(() => document.removeEventListener('visibilitychange', visibility));
    this.removeUiListeners.push(() => window.removeEventListener('pagehide', pagehide));
  }
}

function createSessionConfig(instructions, voice, enableInputTranscription = false) {
  return {
    model: 'higgs-realtime', instructions, output_modalities: ['audio'],
    audio: { input: { format: { type: 'audio/pcm', rate: NATIVE_REALTIME_RATE },
      noise_reduction: { type: 'near_field' }, turn_detection: null,
      ...(enableInputTranscription ? { transcription: { model: 'higgs-stt-3.1', language: 'en' } } : {}) },
      output: { format: { type: 'audio/pcm', rate: NATIVE_REALTIME_RATE }, voice } },
    tools: [], tool_choice: 'none',
  };
}

function isNativeReactionSession(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && safeProviderId(value.residentSessionId) && safeProviderId(value.residentId)
    && typeof value.speakerName === 'string' && value.speakerName.length > 0 && value.speakerName.length <= 80
    && ['chloe', 'oliver', 'jake'].includes(value.voice)
    && typeof value.instructions === 'string' && value.instructions.length > 0 && value.instructions.length <= 4_000
    && validPosition(value.position)
    && typeof value.shortLivedCredential === 'string' && value.shortLivedCredential.startsWith('bai-eph-')
    && Number.isFinite(value.expiresAt) && value.expiresAt > Math.floor(Date.now() / 1_000)
    && typeof value.reactionStream === 'string'
    && value.reactionStream.startsWith(`/boson-ptt/reaction/stream?residentSessionId=${encodeURIComponent(value.residentSessionId)}`));
}

function isRetryableActivationFailure(error) {
  return error instanceof TypeError || (error instanceof Error && error.message === 'invalid_json_response');
}

function isNativeReactionDispatch(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'causalDepth,context,eventId,expiresAt,reactionId,residentId,type,version'
    && value.version === 1 && value.type === 'native.reaction.dispatch'
    && safeProviderId(value.reactionId) && safeProviderId(value.eventId) && safeProviderId(value.residentId)
    && typeof value.context === 'string' && value.context.trim().length > 0
    && utf8Length(value.context) <= MAX_NATIVE_REACTION_CONTEXT_BYTES
    && Number.isSafeInteger(value.causalDepth) && value.causalDepth >= 0 && value.causalDepth <= 2
    && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + 120_000);
}

function validateBegin(value) {
  if (value?.available !== true || !safeProviderId(value.turnId) || !safeProviderId(value.residentSessionId)
    || !safeProviderId(value.residentId) || typeof value.speakerName !== 'string' || typeof value.instructions !== 'string'
    || !['chloe', 'oliver', 'jake'].includes(value.voice) || typeof value.reuseSession !== 'boolean') throw new Error('invalid_native_begin_response');
}

function safeProviderId(value) { return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value) ? value : null; }
function safeCode(value) { return typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : ''; }
const SAFE_FAILURE_STAGES = new Set(['audio_context_create', 'audio_context_resume', 'native_begin', 'native_credential',
  'realtime_websocket', 'realtime_session_ack', 'microphone_capture', 'unknown']);
const SAFE_EXCEPTION_NAMES = new Set(['AbortError', 'NotAllowedError', 'SecurityError', 'NotFoundError', 'DevicesNotFoundError',
  'NotReadableError', 'InvalidStateError', 'NotSupportedError', 'NetworkError', 'TimeoutError', 'TypeError', 'RangeError',
  'SyntaxError', 'DataError', 'OperationError', 'UnknownError', 'Error']);
const SAFE_INTERNAL_FAILURES = new Set(['audio_unavailable', 'resident_session_unavailable', 'credential_unavailable',
  'session_config_mismatch', 'session_ack_timeout', 'provider_connection_failed', 'provider_connection_closed',
  'provider_error', 'invalid_json_response', 'invalid_native_begin_response']);
function safeExceptionName(error) {
  const name = error && typeof error === 'object' && typeof error.name === 'string' ? error.name : 'Error';
  return SAFE_EXCEPTION_NAMES.has(name) ? name : 'Error';
}
function failureCodeFromError(error) {
  const code = safeCode(error instanceof Error ? error.message : '');
  return SAFE_INTERNAL_FAILURES.has(code) ? code : 'provider_error';
}
function structuredPttFailure(path, status, payload) {
  const message = typeof payload?.error === 'string' ? payload.error.toLowerCase() : '';
  if (path === '/boson-ptt/native/begin') {
    if (status === 409 && payload?.available === false && /no resident/.test(message)) return 'no_nearby_resident';
    return `native_begin_http_${status}`;
  }
  if (path === '/boson-ptt/native/credential') return `native_credential_http_${status}`;
  return `native_request_http_${status}`;
}
function validPosition(value) { return Boolean(value && ['x', 'y', 'z'].every((key) => Number.isFinite(value[key]))); }
function appendBounded(previous, next, max) { return `${previous ?? ''}${next}`.slice(0, max); }
function utf8Length(value) { return new TextEncoder().encode(value).length; }
function isEditable(target) {
  return Boolean(target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)
    || target?.closest?.('[contenteditable=""], [contenteditable="true"], [role="textbox"]'));
}
function statusText(value) {
  if (value === 'no_nearby_resident') return 'Walk closer to a villager';
  if (value === 'ready' || String(value).startsWith('ready:')) return 'Ready';
  if (value === 'connecting') return 'Connecting';
  if (value === 'listening') return 'Listening';
  if (value === 'turn_finishing') return 'Finishing turn';
  if (value === 'reply_playing') return 'Resident is replying';
  if (value === 'reply_interrupted') return 'Reply interrupted';
  if (value === 'microphone_released') return 'Microphone released';
  return `Error · ${safeCode(value) || 'audio_failed'}`;
}

export function startNativeResidentAudio(options) {
  const client = new NativeResidentAudioClient(options);
  client.start();
  return client;
}

export function nativeHearingOptionsFromSearch(search) {
  const parameters = new URLSearchParams(search);
  return { enableInputTranscription: parameters.get('nativeResidentAudio') === '1'
    && parameters.get('nativePlayerHearing') === '1' };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  startNativeResidentAudio(nativeHearingOptionsFromSearch(window.location.search));
}
