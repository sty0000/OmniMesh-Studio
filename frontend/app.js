import { createStorageModule } from './storage.js';
import { createApiModule } from './api.js';
import {
  createFrontendConfig,
  applyFrontendConfigPayload,
  createAgentTaskState,
  applyAgentEventToState,
} from './state.js';
import { setupMarkedRenderer, createMarkdownHelpers } from './rendering.js';

const { createApp, ref, reactive, nextTick, onMounted, computed, onBeforeUnmount } = Vue;
const storage = createStorageModule({
  ref,
  indexedDB: window.indexedDB,
  localStorage: window.localStorage,
  LZString: window.LZString,
  Worker: window.Worker,
  Blob: window.Blob,
  URL: window.URL,
  console,
});
const api = createApiModule({
  fetchImpl: window.fetch.bind(window),
  AbortSignalImpl: window.AbortSignal,
  console,
});
setupMarkedRenderer({ marked: window.marked, windowObj: window });
const markdownHelpers = createMarkdownHelpers({
  marked: window.marked,
  renderMathInElement: window.renderMathInElement,
  DOMPurify: window.DOMPurify,
});

      createApp({
        setup() {
          const initialized = ref(false);
          const config = createFrontendConfig(reactive);
          const agentTaskState = createAgentTaskState(reactive);
          const maxModelLenSource = ref('default');
          const maxModelLenSourceLabel = computed(() => {
            if (maxModelLenSource.value === 'api') return 'API /v1/models';
            if (maxModelLenSource.value === 'config') return '前端配置接口';
            return '默认值';
          });

          const autoConfigureAPI = () => {
            const currentHost = window.location.hostname;
            const currentOrigin = window.location.origin;
            if (!currentHost || currentHost === '' || !currentOrigin || currentOrigin === 'null') {
              config.apiBase = 'http://localhost:3000/v1';
            } else {
              config.apiBase = `${currentOrigin}/v1`;
            }
          };
          autoConfigureAPI();

          const params = reactive({
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 8192, // 提高默认值
          });

          const getDefaultInferenceParams = () => ({
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: Math.min(8192, config.maxModelLen),
          });

          const normalizeInferenceParams = (inferenceParams) => {
            const defaults = getDefaultInferenceParams();
            const merged = {
              ...defaults,
              ...(inferenceParams || {}),
            };

            return {
              temperature:
                typeof merged.temperature === 'number' && Number.isFinite(merged.temperature)
                  ? merged.temperature
                  : defaults.temperature,
              top_p:
                typeof merged.top_p === 'number' && Number.isFinite(merged.top_p)
                  ? merged.top_p
                  : defaults.top_p,
              max_tokens:
                typeof merged.max_tokens === 'number' && Number.isFinite(merged.max_tokens)
                  ? Math.min(merged.max_tokens, config.maxModelLen)
                  : defaults.max_tokens,
            };
          };

          const ensureSessionInferenceState = (session) => {
            if (!session) return;
            session.inferenceParams = normalizeInferenceParams(session.inferenceParams);
            if (!session.preset || typeof session.preset !== 'string') {
              session.preset = 'balanced';
            }
          };

          const syncParamsFromSession = (session) => {
            ensureSessionInferenceState(session);
            if (!session || !session.inferenceParams) return;

            params.temperature = session.inferenceParams.temperature;
            params.top_p = session.inferenceParams.top_p;
            params.max_tokens = session.inferenceParams.max_tokens;
            activePreset.value = session.preset || 'balanced';
          };

          const persistCurrentSessionParams = () => {
            const session = currentSession.value;
            if (!session) return;
            ensureSessionInferenceState(session);
            session.inferenceParams = normalizeInferenceParams({
              temperature: params.temperature,
              top_p: params.top_p,
              max_tokens: params.max_tokens,
            });
            session.preset = activePreset.value || 'custom';

            params.temperature = session.inferenceParams.temperature;
            params.top_p = session.inferenceParams.top_p;
            params.max_tokens = session.inferenceParams.max_tokens;
          };

          const activePreset = ref('balanced');
          const sidebarOpen = ref(true);
          const settingsOpen = ref(false);
          const autoScrollEnabled = ref(true);
          const settingsToggleRef = ref(null);
          const settingsPanelRef = ref(null);
          const settingsTitleRef = ref(null);
          const debouncedParamDisplay = reactive({
            temperature: params.temperature,
            top_p: params.top_p,
            max_tokens: params.max_tokens,
          });
          let paramDisplayDebounceTimer = null;

          const closeSettingsPanel = () => {
            settingsOpen.value = false;
          };

          const toggleSettingsPanel = () => {
            settingsOpen.value = !settingsOpen.value;
          };

          const updateBodyScrollLock = (locked) => {
            if (!document || !document.body) return;
            document.body.style.overflow = locked ? 'hidden' : '';
          };

          const handleSettingsKeydown = (event) => {
            if (!settingsOpen.value) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              closeSettingsPanel();
            }
          };

          Vue.watch(
            settingsOpen,
            async (isOpen) => {
              updateBodyScrollLock(isOpen);

              if (isOpen) {
                window.addEventListener('keydown', handleSettingsKeydown);
                await nextTick();
                if (settingsTitleRef.value && typeof settingsTitleRef.value.focus === 'function') {
                  settingsTitleRef.value.focus();
                }
              } else {
                window.removeEventListener('keydown', handleSettingsKeydown);
                await nextTick();
                if (settingsToggleRef.value && typeof settingsToggleRef.value.focus === 'function') {
                  settingsToggleRef.value.focus();
                }
              }
            },
            { immediate: true },
          );

          Vue.watch(
            params,
            (newParams) => {
              if (paramDisplayDebounceTimer) {
                clearTimeout(paramDisplayDebounceTimer);
              }
              paramDisplayDebounceTimer = setTimeout(() => {
                debouncedParamDisplay.temperature = newParams.temperature;
                debouncedParamDisplay.top_p = newParams.top_p;
                debouncedParamDisplay.max_tokens = newParams.max_tokens;
              }, 100);
            },
            { deep: true, immediate: true },
          );

          onBeforeUnmount(() => {
            window.removeEventListener('keydown', handleSettingsKeydown);
            updateBodyScrollLock(false);
            if (paramDisplayDebounceTimer) {
              clearTimeout(paramDisplayDebounceTimer);
            }
          });

          const applyPreset = (presetName) => {
            activePreset.value = presetName;
            if (presetName === 'balanced') {
              params.temperature = 0.7;
              params.top_p = 0.9;
              params.max_tokens = Math.min(8192, config.maxModelLen);
            } else if (presetName === 'creative') {
              params.temperature = 1.2;
              params.top_p = 0.95;
              params.max_tokens = Math.min(16384, config.maxModelLen); // 发散思维可能需要更长输出
            } else if (presetName === 'precise') {
              params.temperature = 0.1;
              params.top_p = 0.1;
              params.max_tokens = Math.min(8192, config.maxModelLen);
            }

            persistCurrentSessionParams();
          };

          const onParamChange = () => {
            activePreset.value = 'custom';
            persistCurrentSessionParams();
          };

          const onMaxTokensCommit = () => {
            const session = currentSession.value;
            const fallbackMaxTokens =
              session && session.inferenceParams && Number.isFinite(session.inferenceParams.max_tokens)
                ? session.inferenceParams.max_tokens
                : getDefaultInferenceParams().max_tokens;

            const parsed = Number(params.max_tokens);
            const normalized =
              Number.isFinite(parsed) && parsed > 0
                ? Math.floor(parsed)
                : fallbackMaxTokens;

            params.max_tokens = Math.max(1, Math.min(config.maxModelLen, normalized));
            onParamChange();
          };

          const multiTurn = ref(true);
          const inputPrompt = ref('');
          const isGenerating = ref(false);
          const isRequestDispatching = ref(false);
          const chatContainer = ref(null);
          const composerTextarea = ref(null);
          const activeMessageIndex = ref(-1);
          const editInputRef = ref(null);
          let pendingAutoScrollRaf = null;

          const STREAM_TICK_MS = 16;
          const STREAM_MIN_CHARS_PER_TICK = 2;
          const STREAM_MAX_CHARS_PER_TICK = 24;
          const streamDisplayBuffers = new Map();
          let streamDrainTimer = null;

          const estimateCharsPerTick = (pendingLength) => {
            const dynamic = Math.ceil(pendingLength / 80);
            return Math.min(
              STREAM_MAX_CHARS_PER_TICK,
              Math.max(STREAM_MIN_CHARS_PER_TICK, dynamic),
            );
          };

          const hasStreamBufferPending = () => {
            for (const state of streamDisplayBuffers.values()) {
              if (state.pending.length > 0 || !state.done) {
                return true;
              }
            }
            return false;
          };

          const scheduleStreamDrain = () => {
            if (streamDrainTimer !== null) return;
            streamDrainTimer = window.setTimeout(() => {
              streamDrainTimer = null;
              let touched = false;

              for (const [index, state] of streamDisplayBuffers.entries()) {
                if (!messages.value[index] || messages.value[index].role !== 'assistant') {
                  streamDisplayBuffers.delete(index);
                  continue;
                }

                if (!state.pending.length) {
                  if (state.done) {
                    streamDisplayBuffers.delete(index);
                  }
                  continue;
                }

                const takeCount = estimateCharsPerTick(state.pending.length);
                const outgoing = state.pending.slice(0, takeCount);
                state.pending = state.pending.slice(takeCount);
                messages.value[index].content += outgoing;
                touched = true;

                if (!state.pending.length && state.done) {
                  streamDisplayBuffers.delete(index);
                }
              }

              if (touched) {
                scrollToBottom();
              }

              if (hasStreamBufferPending()) {
                scheduleStreamDrain();
              }
            }, STREAM_TICK_MS);
          };

          const appendAssistantContentBuffered = (index, text) => {
            if (!text) return;
            let state = streamDisplayBuffers.get(index);
            if (!state) {
              state = { pending: '', done: false };
              streamDisplayBuffers.set(index, state);
            }
            state.pending += text;
            scheduleStreamDrain();
          };

          const markAssistantBufferDone = (index) => {
            let state = streamDisplayBuffers.get(index);
            if (!state) {
              state = { pending: '', done: true };
              streamDisplayBuffers.set(index, state);
            }
            state.done = true;
            scheduleStreamDrain();
          };

          const flushAssistantBuffer = (index) => {
            const state = streamDisplayBuffers.get(index);
            if (!state || !messages.value[index]) return;
            if (state.pending) {
              messages.value[index].content += state.pending;
            }
            streamDisplayBuffers.delete(index);
          };

          const discardAssistantBuffer = (index) => {
            streamDisplayBuffers.delete(index);
          };

          // Session Management
          const generateId = () => Math.random().toString(36).substr(2, 9);
          const {
            STORAGE_KEY,
            initialForceScrollEnabled,
            hasUserInteractedWithScroll,
            isInitialLoading,
            setInitialForceScrollEnabled,
            saveLastActiveSessionId,
            loadLastActiveSessionId,
            saveToIndexedDB,
            loadFromIndexedDB,
          } = storage;

          // Initialize state
          const sessions = ref([
            {
              id: generateId(),
              name: '对话 1',
              messages: [],
              inferenceParams: getDefaultInferenceParams(),
              preset: 'balanced',
            },
          ]);
          const currentSessionId = ref(sessions.value[0].id);
          const editingSessionId = ref(null);
          const editingSessionName = ref('');

          const normalizeSessionTitle = (title) => {
            return String(title || '').trim().toLowerCase();
          };

          const getUniqueSessionTitle = (baseTitle, excludeSessionId = null) => {
            const trimmedBase = String(baseTitle || '').trim() || '未命名对话';
            const usedTitleKeys = new Set(
              sessions.value
                .filter((session) => session.id !== excludeSessionId)
                .map((session) => normalizeSessionTitle(session.name)),
            );

            if (!usedTitleKeys.has(normalizeSessionTitle(trimmedBase))) {
              return trimmedBase;
            }

            let suffix = 2;
            let candidate = `${trimmedBase} (${suffix})`;
            while (usedTitleKeys.has(normalizeSessionTitle(candidate))) {
              suffix += 1;
              candidate = `${trimmedBase} (${suffix})`;
            }

            return candidate;
          };

          // Watch and save sessions to IndexedDB asynchronously
          // We use a simple debounce to avoid hammering the DB on every keystroke/token
          let saveTimeout = null;
          Vue.watch(
            sessions,
            (newSessions) => {
              if (saveTimeout) clearTimeout(saveTimeout);
              // Create a deep clone to prevent proxy reactivity issues during async save
              const sessionsClone = JSON.parse(JSON.stringify(newSessions));

              saveTimeout = setTimeout(() => {
                saveToIndexedDB(sessionsClone).catch((err) => {
                  console.error('Async save failed', err);
                });
              }, 1000); // 1 second debounce
            },
            { deep: true },
          );

          const currentSession = computed(() => {
            return sessions.value.find((s) => s.id === currentSessionId.value) || sessions.value[0];
          });

          const messages = computed(() => {
            return currentSession.value.messages;
          });

          const normalizeAllSessionsInferenceState = () => {
            for (const session of sessions.value) {
              ensureSessionInferenceState(session);
            }
          };

          Vue.watch(
            currentSessionId,
            () => {
              syncParamsFromSession(currentSession.value);
            },
            { immediate: true },
          );

          const WINDOW_SIZE = 20;
          const WINDOW_EXPAND_STEP = 20;
          const WINDOW_TOP_EXPAND_THRESHOLD = 120;
          const visibleStartIndex = ref(0);
          const isExpandingHistory = ref(false);

          const visibleMessages = computed(() => {
            return messages.value.slice(visibleStartIndex.value);
          });

          const resetVisibleWindowToLatest = () => {
            const total = messages.value.length;
            visibleStartIndex.value = Math.max(0, total - WINDOW_SIZE);
          };

          const expandVisibleWindowUpward = async (targetIndex = null) => {
            if (!chatContainer.value) return;
            if (visibleStartIndex.value <= 0) return;
            if (isExpandingHistory.value) return;

            const previousStart = visibleStartIndex.value;
            const previousScrollHeight = chatContainer.value.scrollHeight;
            const previousScrollTop = chatContainer.value.scrollTop;

            let nextStart;
            if (typeof targetIndex === 'number' && targetIndex >= 0) {
              nextStart = Math.min(previousStart, Math.max(0, targetIndex));
            } else {
              nextStart = Math.max(0, previousStart - WINDOW_EXPAND_STEP);
            }

            if (nextStart === previousStart) return;

            isExpandingHistory.value = true;
            visibleStartIndex.value = nextStart;
            await nextTick();

            const nextScrollHeight = chatContainer.value.scrollHeight;
            const heightDelta = nextScrollHeight - previousScrollHeight;
            chatContainer.value.scrollTop = previousScrollTop + Math.max(0, heightDelta);
            isExpandingHistory.value = false;
          };

          const currentSessionSystemPrompt = computed({
            get: () => currentSession.value.systemPrompt || '',
            set: (val) => {
              if (!isSystemPromptLocked.value) {
                currentSession.value.systemPrompt = val;
              }
            },
          });

          const isSystemPromptLocked = computed(() => {
            // Lock the prompt if there are any messages in the current session
            return currentSession.value.messages && currentSession.value.messages.length > 0;
          });

          const updateSessionSystemPrompt = (e) => {
            if (!isSystemPromptLocked.value) {
              currentSessionSystemPrompt.value = e.target.value;
              // If user manually types, set dropdown to 'custom'
              selectedTemplate.value = 'custom';
            }
          };

          const selectedTemplate = ref('');

          // Sync dropdown with current session's prompt when switching sessions
          Vue.watch(
            currentSessionSystemPrompt,
            (newVal) => {
              if (!newVal) {
                selectedTemplate.value = '';
                return;
              }
              // Check if current prompt matches any template (ignoring the dynamic <时间> replacement for matching)
              const matchedTemplate = systemPromptTemplates.find((tpl) => {
                // If it's the time template, the actual prompt might contain real time,
                // but before sending it contains `<时间>`. So exact match is fine here for the dropdown state.
                return tpl.content === newVal;
              });
              if (matchedTemplate) {
                selectedTemplate.value = matchedTemplate.content;
              } else {
                selectedTemplate.value = 'custom';
              }
            },
            { immediate: true },
          );

          // Default System Prompt Templates
          const systemPromptTemplates = [
            {
              name: '代码专家',
              content:
                '你是一个资深的程序员和软件架构师。请提供清晰、高效、带有详尽注释的代码，并在给出代码前简要说明你的设计思路。如果用户的需求有逻辑漏洞，请指出并提供更好的方案。',
            },
            {
              name: '学术翻译',
              content:
                '你是一个专业的学术翻译专家。请将用户输入的文本在中文和英文之间进行互译。要求：语言必须符合学术期刊的正式、严谨风格，准确使用专业术语，句子结构需符合目标语言的母语习惯，不要有明显的机翻感。',
            },
            {
              name: '逻辑推理大师',
              content:
                '你是一个逻辑极其严密的推理专家。在回答问题时，请务必进行极其深度的、多步骤的思考。请列出所有可能的情况，逐一分析排除，并在最后给出唯一正确的结论。',
            },
            {
              name: '时间感知 (Qwen3-Omni)',
              content:
                '你是Qwen3-Omni-Thinking，现在是<时间>。请在回答时结合当前时间提供最准确的信息。',
            },
            {
              name: '前端开发 (Vue/React)',
              content:
                '你是一个现代前端开发专家，精通 Vue 3, React, Tailwind CSS 和现代工程化。请在回答时侧重于用户体验（UX）、响应式设计、可访问性（a11y）以及组件的高复用性。代码需直接可用。',
            },
            {
              name: 'JSON 格式化输出',
              content:
                '你是一个数据提取和转换引擎。无论用户输入什么，你只能输出合法的、可被 JSON.parse() 解析的纯 JSON 字符串。绝对不能输出任何解释性文字，不要使用 Markdown 代码块包裹，只输出 JSON 文本。',
            },
          ];

          const applySystemPromptTemplate = (e) => {
            if (!isSystemPromptLocked.value) {
              if (e.target.value === 'custom') {
                // Do nothing to the text, just let user edit
                return;
              }
              let templateContent = e.target.value;
              // Note: We keep the <时间> placeholder in the text area so user knows it's dynamic.
              // It will be replaced when actually sending the payload.
              currentSessionSystemPrompt.value = templateContent;
            }
          };

          const createNewSession = () => {
            const newId = generateId();
            const baseName = `对话 ${sessions.value.length + 1}`;
            sessions.value.push({
              id: newId,
              name: getUniqueSessionTitle(baseName),
              messages: [],
              inferenceParams: getDefaultInferenceParams(),
              preset: 'balanced',
            });
            currentSessionId.value = newId;
            saveLastActiveSessionId(newId);
            resetVisibleWindowToLatest();
          };

          const switchSession = (id) => {
            if (isGenerating.value) return; // Prevent switching while generating
            if (editingSessionId.value === id) return; // Prevent switch logic if editing this session
            currentSessionId.value = id;
            saveLastActiveSessionId(id);
            resetVisibleWindowToLatest();
            ensureRenderCacheForVisibleMessages();
            autoScrollEnabled.value = true;
            scrollToBottom(true);
          };

          const startEditSession = (session) => {
            editingSessionId.value = session.id;
            editingSessionName.value = session.name;
            // Focus the input next tick
            nextTick(() => {
              if (editInputRef.value && editInputRef.value.length > 0) {
                editInputRef.value[0].focus();
                editInputRef.value[0].select();
              }
            });
          };

          const saveSessionName = () => {
            if (editingSessionId.value) {
              const session = sessions.value.find((s) => s.id === editingSessionId.value);
              if (session) {
                const requestedTitle = editingSessionName.value.trim() || '未命名对话';
                session.name = getUniqueSessionTitle(requestedTitle, session.id);
              }
              editingSessionId.value = null;
            }
          };

          const deleteSession = (id) => {
            if (isGenerating.value) return;
            const index = sessions.value.findIndex((s) => s.id === id);
            if (index > -1) {
              // Ensure the session is completely removed from the array
              sessions.value.splice(index, 1);

              // If we deleted the currently active session, switch to a nearby one
              if (currentSessionId.value === id) {
                currentSessionId.value = sessions.value[Math.max(0, index - 1)].id;
                saveLastActiveSessionId(currentSessionId.value);
                resetVisibleWindowToLatest();
              }

              // Force an immediate save to database to guarantee deletion persists
              const sessionsClone = JSON.parse(JSON.stringify(sessions.value));
              saveToIndexedDB(sessionsClone).catch((err) => {
                console.error('Immediate save after deletion failed', err);
              });
            }
          };

          const clearCurrentChat = () => {
            if (currentSession.value) {
              currentSession.value.messages = [];
              currentSession.value.systemPrompt = '';
              ensureSessionInferenceState(currentSession.value);
              // Force an immediate save to database to guarantee clear persists
              const sessionsClone = JSON.parse(JSON.stringify(sessions.value));
              saveToIndexedDB(sessionsClone).catch((err) => {
                console.error('Immediate save after clear failed', err);
              });
            }
          };
          const pendingMedia = ref([]);
          const mediaError = ref('');

          // Voice Input State
          const isRecording = ref(false);
          let mediaRecorder = null;
          let audioChunks = [];

          const toggleVoiceInput = async () => {
            if (isRecording.value) {
              if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop();
              }
              isRecording.value = false;
            } else {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];

                mediaRecorder.ondataavailable = (event) => {
                  if (event.data.size > 0) audioChunks.push(event.data);
                };

                mediaRecorder.onstop = () => {
                  const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });

                  // Because Qwen3-Omni-Thinking supports audio input directly via multimodal API,
                  // we read the audio blob as base64 and add it to pendingMedia.
                  const reader = new FileReader();
                  reader.onload = (e) => {
                    pendingMedia.value.push({
                      type: 'audio',
                      url: e.target.result,
                      file: new File([audioBlob], 'voice_record.webm', { type: 'audio/webm' }),
                    });
                  };
                  reader.readAsDataURL(audioBlob);

                  stream.getTracks().forEach((track) => track.stop());
                };

                mediaRecorder.start();
                isRecording.value = true;
              } catch (err) {
                console.error('麦克风访问错误:', err);
                alert('无法访问麦克风，请检查浏览器权限。');
              }
            }
          };

          // Maximum limits based on standard API constraints (can be adjusted)
          const MAX_IMAGES = 2;
          const MAX_VIDEOS = 1;
          const MAX_AUDIOS = 1;
          const MAX_FILE_SIZE_MB = 10;

          const handleMediaUpload = (event) => {
            const files = Array.from(event.target.files);
            if (!files.length) return;

            mediaError.value = '';

            let currentImages = pendingMedia.value.filter((m) => m.type === 'image').length;
            let currentVideos = pendingMedia.value.filter((m) => m.type === 'video').length;
            let currentAudios = pendingMedia.value.filter((m) => m.type === 'audio').length;

            files.forEach((file) => {
              // Check file size
              if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
                mediaError.value = `文件 ${file.name} 超过 ${MAX_FILE_SIZE_MB}MB 限制`;
                return;
              }

              const isImage = file.type.startsWith('image/');
              const isVideo = file.type.startsWith('video/');
              const isAudio = file.type.startsWith('audio/');

              if (isImage) {
                if (currentImages >= MAX_IMAGES) {
                  mediaError.value = `最多只能上传 ${MAX_IMAGES} 张图片`;
                  return;
                }
                currentImages++;
              } else if (isVideo) {
                if (currentVideos >= MAX_VIDEOS) {
                  mediaError.value = `最多只能上传 ${MAX_VIDEOS} 个视频`;
                  return;
                }
                currentVideos++;
              } else if (isAudio) {
                if (currentAudios >= MAX_AUDIOS) {
                  mediaError.value = `最多只能上传 ${MAX_AUDIOS} 个音频`;
                  return;
                }
                currentAudios++;
              } else {
                mediaError.value = '不支持的文件格式';
                return;
              }

              const reader = new FileReader();
              reader.onload = (e) => {
                let mediaType = 'image';
                if (isVideo) mediaType = 'video';
                if (isAudio) mediaType = 'audio';

                pendingMedia.value.push({
                  type: mediaType,
                  url: e.target.result,
                  file: file,
                });
              };
              reader.readAsDataURL(file);
            });

            // Reset input so the same file can be selected again if removed
            if (event.target) event.target.value = '';
          };

          const removePendingMedia = (index) => {
            pendingMedia.value.splice(index, 1);
            mediaError.value = '';
          };

          let abortController = null;

          const scrollToLastMessageAnchor = async (force = false, behavior = 'auto') => {
            await nextTick();
            if (!chatContainer.value) return;

            if (!force && !autoScrollEnabled.value) {
              updateActiveMessageIndex();
              return;
            }

            const lastIndex = messages.value.length - 1;
            if (lastIndex >= 0 && lastIndex < visibleStartIndex.value) {
              resetVisibleWindowToLatest();
              await nextTick();
            }

            const anchorId = messages.value.length > 0 ? `msg-${messages.value.length - 1}` : null;
            const anchorEl = anchorId ? document.getElementById(anchorId) : null;

            if (anchorEl && chatContainer.value) {
              const targetTop =
                anchorEl.offsetTop -
                chatContainer.value.offsetTop +
                anchorEl.offsetHeight -
                chatContainer.value.clientHeight +
                16;

              chatContainer.value.scrollTo({
                top: Math.max(0, targetTop),
                behavior,
              });
            } else if (chatContainer.value) {
              chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
            }

            updateActiveMessageIndex();
          };

          const requestAutoScroll = (force = false, behavior = 'auto') => {
            if (isExpandingHistory.value) {
              window.setTimeout(() => requestAutoScroll(force, behavior), 16);
              return;
            }

            if (pendingAutoScrollRaf !== null) {
              cancelAnimationFrame(pendingAutoScrollRaf);
            }

            pendingAutoScrollRaf = requestAnimationFrame(async () => {
              pendingAutoScrollRaf = null;
              await scrollToLastMessageAnchor(force, behavior);
            });
          };

          const scrollToBottom = (force = false) => {
            requestAutoScroll(force, 'auto');
          };

          const scrollToMessage = (index) => {
            if (index < visibleStartIndex.value) {
              expandVisibleWindowUpward(index).then(() => {
                scrollToMessage(index);
              });
              return;
            }

            const el = document.getElementById('msg-' + index);
            if (el && chatContainer.value) {
              // Disable auto-scroll temporarily since user is manually navigating
              autoScrollEnabled.value = false;
              if (pendingAutoScrollRaf !== null) {
                cancelAnimationFrame(pendingAutoScrollRaf);
                pendingAutoScrollRaf = null;
              }
              chatContainer.value.scrollTo({
                top: el.offsetTop - chatContainer.value.offsetTop - 20,
                behavior: 'smooth',
              });
              activeMessageIndex.value = index;
            }
          };

          // Throttled scroll handler to update active dot and auto-scroll state
          let scrollTimeout;
          const handleScroll = () => {
            if (isInitialLoading.value) return;
            hasUserInteractedWithScroll.value = true;

            if (
              chatContainer.value &&
              visibleStartIndex.value > 0 &&
              chatContainer.value.scrollTop < WINDOW_TOP_EXPAND_THRESHOLD
            ) {
              expandVisibleWindowUpward();
            }

            if (scrollTimeout) return;
            scrollTimeout = setTimeout(() => {
              updateActiveMessageIndex();

              // Check if user scrolled up to disable auto-scroll
              if (chatContainer.value) {
                const { scrollTop, scrollHeight, clientHeight } = chatContainer.value;
                const isAtBottom = scrollHeight - scrollTop - clientHeight < 10; // 10px tolerance

                // If user scrolled up (not at bottom), disable auto scroll.
                // If they scrolled back to bottom, re-enable it.
                autoScrollEnabled.value = isAtBottom;
              }

              scrollTimeout = null;
            }, 100);
          };

          const runInitialScrollCalibration = async () => {
            if (!initialForceScrollEnabled.value) return;
            if (hasUserInteractedWithScroll.value) return;

            autoScrollEnabled.value = true;
            await scrollToBottom(true);

            const guardedCalibrate = (delayMs) => {
              window.setTimeout(() => {
                if (!initialForceScrollEnabled.value) return;
                if (hasUserInteractedWithScroll.value) return;
                if (!autoScrollEnabled.value) return;
                scrollToBottom(true);
              }, delayMs);
            };

            guardedCalibrate(140);
            guardedCalibrate(380);
          };

          const updateActiveMessageIndex = () => {
            if (!chatContainer.value) return;

            const containerTop = chatContainer.value.scrollTop;
            const containerHeight = chatContainer.value.clientHeight;
            const containerBottom = containerTop + containerHeight;

            // Find the user message that is most visible or closest to top
            let bestIndex = -1;
            let minDistance = Infinity;

            for (let i = 0; i < messages.value.length; i++) {
              if (i < visibleStartIndex.value) continue;
              if (messages.value[i].role === 'user') {
                const el = document.getElementById('msg-' + i);
                if (el) {
                  const elTop = el.offsetTop - chatContainer.value.offsetTop;
                  const elBottom = elTop + el.offsetHeight;

                  // Check if element is in viewport
                  if (elTop < containerBottom && elBottom > containerTop) {
                    // Calculate distance from center of viewport
                    const viewportCenter = containerTop + containerHeight / 2;
                    const elCenter = elTop + el.offsetHeight / 2;
                    const distance = Math.abs(viewportCenter - elCenter);

                    if (distance < minDistance) {
                      minDistance = distance;
                      bestIndex = i;
                    }
                  }
                }
              }
            }

            if (bestIndex !== -1) {
              activeMessageIndex.value = bestIndex;
            }
          };

          const applyModelInfo = (modelInfo) => {
            if (!modelInfo) return;
            config.model = modelInfo.id || 'qwen';
            if (modelInfo.max_model_len) {
              config.maxModelLen = modelInfo.max_model_len;
              maxModelLenSource.value = 'api';
              normalizeAllSessionsInferenceState();
              syncParamsFromSession(currentSession.value);
              persistCurrentSessionParams();
            }
          };

          const loadModelInfoFromApi = async () => {
            try {
              const modelInfo = await api.loadModelInfoFromApi({
                apiBase: config.apiBase,
                apiKey: config.apiKey,
              });
              if (modelInfo) {
                applyModelInfo(modelInfo);
                return true;
              }
            } catch (apiErr) {
              console.warn('Failed to fetch model info from API:', apiErr);
            }

            return false;
          };

          const previewAgentTask = async (promptText) => {
            if (!config.agentTasksEnabled || !config.apiKey) return false;
            agentTaskState.taskId = '';
            agentTaskState.requestId = '';
            agentTaskState.sessionId = currentSessionId.value || '';
            agentTaskState.traceId = '';
            agentTaskState.status = 'queued';
            agentTaskState.thinking = '';
            agentTaskState.finalMessage = '';
            agentTaskState.toolCalls = [];
            agentTaskState.events = [];
            agentTaskState.lastError = '';

            await api.runAgentTask({
              apiBase: config.apiBase,
              apiKey: config.apiKey,
              input: promptText,
              sessionId: currentSessionId.value,
              onEvent: (event) => {
                applyAgentEventToState({ state: agentTaskState, event });
              },
            });
            return true;
          };

          // Load data asynchronously on mount
          onMounted(async () => {
            initialized.value = true;
            isInitialLoading.value = true;
            hasUserInteractedWithScroll.value = false;

            try {
              const frontendConfig = await api.loadFrontendConfig();
              applyFrontendConfigPayload({ config, maxModelLenSource, payload: frontendConfig });
              normalizeAllSessionsInferenceState();
            } catch (configErr) {
              console.warn('Failed to load frontend config, fallback to local defaults', configErr);
              autoConfigureAPI();
            }

            // Try loading from IndexedDB first (huge capacity)
            let loadedSessions = await loadFromIndexedDB();

            // Fallback to legacy localStorage if IndexedDB is empty (migration)
            if (!loadedSessions) {
              const legacyStored = localStorage.getItem(STORAGE_KEY);
              if (legacyStored) {
                try {
                  loadedSessions = JSON.parse(legacyStored);
                  // Optional: migrate it to IndexedDB immediately
                  saveToIndexedDB(loadedSessions);
                } catch (e) {
                  console.error('Failed to parse legacy localStorage', e);
                }
              }
            }

            if (loadedSessions && Array.isArray(loadedSessions) && loadedSessions.length > 0) {
              sessions.value = loadedSessions;
              normalizeAllSessionsInferenceState();
              const lastActiveId = loadLastActiveSessionId();
              const matchedSession = lastActiveId
                ? sessions.value.find((session) => session.id === lastActiveId)
                : null;
              currentSessionId.value = matchedSession ? matchedSession.id : loadedSessions.at(-1).id;
              saveLastActiveSessionId(currentSessionId.value);
              syncParamsFromSession(currentSession.value);
            }

            if (config.apiKey) {
              await loadModelInfoFromApi();
            }

            resetVisibleWindowToLatest();

            ensureRenderCacheForVisibleMessages();

            try {
              await runInitialScrollCalibration();
            } finally {
              window.setTimeout(() => {
                isInitialLoading.value = false;
              }, 1000);
            }
          });

          const MARKDOWN_RENDER_INTERVAL_MS = 70;
          const MARKDOWN_CACHE_MAX = 80;
          const RENDER_CACHE_VERSION = 'v1';
          const markdownFrameTick = ref(0);
          const markdownCache = new Map();
          const markdownRenderStates = new Map();
          let markdownCacheSerial = 0;
          let markdownRenderTimer = null;
          const pendingBackfillIndices = new Set();
          let backfillScheduled = false;

          const rememberMarkdownCache = (key, html) => {
            if (!markdownCache.has(key) && markdownCache.size >= MARKDOWN_CACHE_MAX) {
              let oldestKey = null;
              let oldestSerial = Infinity;
              for (const [cacheKey, cacheVal] of markdownCache.entries()) {
                if (cacheVal.serial < oldestSerial) {
                  oldestSerial = cacheVal.serial;
                  oldestKey = cacheKey;
                }
              }
              if (oldestKey !== null) {
                markdownCache.delete(oldestKey);
              }
            }
            markdownCache.set(key, { html, serial: ++markdownCacheSerial });
          };

          const scheduleMarkdownRenderTick = () => {
            if (markdownRenderTimer !== null) return;
            markdownRenderTimer = window.setTimeout(() => {
              markdownRenderTimer = null;
              markdownFrameTick.value += 1;
            }, MARKDOWN_RENDER_INTERVAL_MS);
          };

          const { renderMarkdownSegment, splitMarkdownSegments } = markdownHelpers;

          const renderMarkdownNow = (source, cacheScope) => {
            const cacheKey = `${cacheScope}::${source}`;
            const cached = markdownCache.get(cacheKey);
            if (cached) {
              cached.serial = ++markdownCacheSerial;
              return cached.html;
            }

            const segments = splitMarkdownSegments(source);
            if (segments.length > 1 && source.length > 1200) {
              const htmlParts = [];
              for (let i = 0; i < segments.length; i++) {
                const segment = segments[i];
                const segmentKey = `${cacheScope}::seg:${i}::${segment}`;
                const segmentCached = markdownCache.get(segmentKey);
                if (segmentCached) {
                  segmentCached.serial = ++markdownCacheSerial;
                  htmlParts.push(segmentCached.html);
                } else {
                  const segmentHtml = renderMarkdownSegment(segment);
                  rememberMarkdownCache(segmentKey, segmentHtml);
                  htmlParts.push(segmentHtml);
                }
              }
              const merged = htmlParts.join('');
              rememberMarkdownCache(cacheKey, merged);
              return merged;
            }

            const finalHtml = renderMarkdownSegment(source);
            rememberMarkdownCache(cacheKey, finalHtml);
            return finalHtml;
          };

          const renderMarkdown = (text, cacheScope = 'default') => {
            markdownFrameTick.value;
            if (!text) return '';

            const source = String(text);
            let state = markdownRenderStates.get(cacheScope);
            if (!state) {
              state = {
                lastText: '',
                lastHtml: '',
                lastRenderAt: 0,
                pendingText: '',
              };
              markdownRenderStates.set(cacheScope, state);
            }

            if (source === state.lastText) {
              return state.lastHtml;
            }

            state.pendingText = source;

            const now = performance.now();
            const elapsed = now - state.lastRenderAt;
            const shouldRenderNow = state.lastRenderAt === 0 || elapsed >= MARKDOWN_RENDER_INTERVAL_MS;

            if (shouldRenderNow) {
              const nextText = state.pendingText;
              state.lastHtml = renderMarkdownNow(nextText, cacheScope);
              state.lastText = nextText;
              state.lastRenderAt = now;
              state.pendingText = '';
              return state.lastHtml;
            }

            scheduleMarkdownRenderTick();
            return state.lastHtml;
          };

          const hasRenderableMessageCache = (msg) => {
            return !!(
              msg &&
              msg.role === 'assistant' &&
              msg.renderCacheVersion === RENDER_CACHE_VERSION &&
              msg.renderedHtml
            );
          };

          const hasRenderableThinkingCache = (msg) => {
            if (!msg || msg.role !== 'assistant') return false;
            if (msg.renderCacheVersion !== RENDER_CACHE_VERSION) return false;
            if (!msg.thinking) return true;
            return !!msg.thinkingRenderedHtml;
          };

          const finalizeMessageRenderCache = (index) => {
            const msg = messages.value[index];
            if (!msg || msg.role !== 'assistant') return false;
            if (msg.error) return false;

            const renderedHtml = renderMarkdown(msg.content || '', `content-${index}`);
            let thinkingRenderedHtml = '';
            if (msg.thinking) {
              thinkingRenderedHtml = renderMarkdown(msg.thinking, `thinking-${index}`);
            }

            const contentUnchanged = msg.renderedHtml === renderedHtml;
            const thinkingUnchanged = (msg.thinkingRenderedHtml || '') === thinkingRenderedHtml;
            const versionUnchanged = msg.renderCacheVersion === RENDER_CACHE_VERSION;

            if (contentUnchanged && thinkingUnchanged && versionUnchanged) {
              return false;
            }

            msg.renderedHtml = renderedHtml;
            msg.thinkingRenderedHtml = thinkingRenderedHtml;
            msg.renderCacheVersion = RENDER_CACHE_VERSION;
            return true;
          };

          const scheduleIdle = (task) => {
            if (typeof window.requestIdleCallback === 'function') {
              return window.requestIdleCallback(task, { timeout: 1200 });
            }
            return window.setTimeout(task, 48);
          };

          const flushRenderCacheBackfill = () => {
            if (!pendingBackfillIndices.size) {
              backfillScheduled = false;
              return;
            }

            const queue = Array.from(pendingBackfillIndices);
            pendingBackfillIndices.clear();
            let changed = false;

            for (const index of queue) {
              changed = finalizeMessageRenderCache(index) || changed;
            }

            backfillScheduled = false;

            if (changed) {
              const sessionsClone = JSON.parse(JSON.stringify(sessions.value));
              saveToIndexedDB(sessionsClone).catch((err) => {
                console.error('Backfill render cache save failed', err);
              });
            }

            if (pendingBackfillIndices.size) {
              scheduleRenderCacheBackfill();
            }
          };

          const scheduleRenderCacheBackfill = () => {
            if (backfillScheduled) return;
            backfillScheduled = true;
            scheduleIdle(() => {
              flushRenderCacheBackfill();
            });
          };

          const ensureRenderCacheForVisibleMessages = () => {
            for (let index = 0; index < messages.value.length; index++) {
              const msg = messages.value[index];
              if (!msg || msg.role !== 'assistant') continue;
              if (msg.error) continue;

              const hasContentCache = hasRenderableMessageCache(msg);
              const hasThinkingCache = hasRenderableThinkingCache(msg);
              if (!hasContentCache || !hasThinkingCache) {
                pendingBackfillIndices.add(index);
              }
            }

            if (pendingBackfillIndices.size) {
              scheduleRenderCacheBackfill();
            }
          };

          const stopGeneration = () => {
            if (abortController) {
              abortController.abort();
              abortController = null;
              isGenerating.value = false;

              // Also ensure we stop any "thinking" state on the current assistant message
              if (messages.value.length > 0) {
                const lastMsg = messages.value[messages.value.length - 1];
                if (lastMsg.role === 'assistant' && lastMsg.isThinking) {
                  lastMsg.isThinking = false;
                }
              }
            }
          };

          const buildPayload = (promptStr, mediaItems = []) => {
            const validParams = validateParams({ ...params, max_model_len: config.maxModelLen });
            let chatMessages = [];

            const isSameMessageContent = (left, right) => {
              if (typeof left === 'string' && typeof right === 'string') {
                return left === right;
              }
              if (Array.isArray(left) && Array.isArray(right)) {
                try {
                  return JSON.stringify(left) === JSON.stringify(right);
                } catch {
                  return false;
                }
              }
              return false;
            };

            if (multiTurn.value) {
              // filter out errors and the currently generating empty assistant message
              chatMessages = messages.value
                .filter((m) => !m.error && m.content !== '')
                .map((m) => {
                  // Support multimodal history if needed, for now we just pass content.
                  let content = m.content;
                  if (Array.isArray(m.rawContent)) {
                    content = m.rawContent;
                  }
                  return { role: m.role, content: content };
                });
            }

            // Inject System Prompt if available for this specific session
            if (
              currentSessionSystemPrompt.value &&
              currentSessionSystemPrompt.value.trim() !== ''
            ) {
              let finalSystemPrompt = currentSessionSystemPrompt.value.trim();
              // Dynamically replace <时间> placeholder right before sending to ensure real-time accuracy
              if (finalSystemPrompt.includes('<时间>')) {
                finalSystemPrompt = finalSystemPrompt.replace(/<时间>/g, formatCurrentTime());
              }
              chatMessages.unshift({
                role: 'system',
                content: finalSystemPrompt,
              });
            }

            // Construct current message content
            let currentContent;
            if (mediaItems.length > 0) {
              currentContent = [];
              // Add media
              mediaItems.forEach((media) => {
                if (media.type === 'image') {
                  currentContent.push({
                    type: 'image_url',
                    image_url: { url: media.url },
                  });
                } else if (media.type === 'video') {
                  currentContent.push({
                    type: 'video_url',
                    video_url: { url: media.url },
                  });
                } else if (media.type === 'audio') {
                  // vLLM Qwen3-Omni format for audio
                  currentContent.push({
                    type: 'audio_url',
                    audio_url: { url: media.url },
                  });
                }
              });

              // Input Sequence Best Practice: The question or prompt should come after multimodal data
              if (promptStr.trim()) {
                currentContent.push({ type: 'text', text: promptStr });
              }
            } else {
              currentContent = promptStr;
            }

            const lastHistoryMessage = chatMessages[chatMessages.length - 1];
            const shouldAppendCurrentMessage = !(
              multiTurn.value &&
              lastHistoryMessage &&
              lastHistoryMessage.role === 'user' &&
              isSameMessageContent(lastHistoryMessage.content, currentContent)
            );

            if (shouldAppendCurrentMessage) {
              chatMessages.push({ role: 'user', content: currentContent });
            }

            return {
              model: config.model,
              messages: chatMessages,
              stream: true,
              ...validParams,
            };
          };

          const isConnected = ref(true);
          let reconnectInterval = null;

          const performRequest = async (promptStr, mediaItems = [], msgIndexToRetry = null) => {
            if (isGenerating.value || isRequestDispatching.value) return;

            isRequestDispatching.value = true;
            isGenerating.value = true;
            abortController = new AbortController();

            let targetIndex;
            if (msgIndexToRetry !== null) {
              // We are retrying an assistant message
              targetIndex = msgIndexToRetry;
              messages.value[targetIndex] = {
                role: 'assistant',
                content: '',
                thinking: '',
                isThinking: true,
                showThinking: false,
                usage: null,
                error: null,
                renderedHtml: '',
                thinkingRenderedHtml: '',
                renderCacheVersion: null,
              };
            } else {
              // For UI display, we just show the text prompt. Media is shown via a different UI indicator if needed.
              messages.value.push({
                role: 'user',
                content: promptStr,
                rawContent:
                  mediaItems.length > 0
                    ? buildPayload(promptStr, mediaItems).messages.slice(-1)[0].content
                    : null,
              });
              targetIndex =
                messages.value.push({
                  role: 'assistant',
                  content: '',
                  thinking: '',
                  isThinking: true,
                  showThinking: false,
                  usage: null,
                  error: null,
                  renderedHtml: '',
                  thinkingRenderedHtml: '',
                  renderCacheVersion: null,
                }) - 1;
            }

            discardAssistantBuffer(targetIndex);

            // Reset auto-scroll flag to true on new request
            autoScrollEnabled.value = true;

            scrollToBottom(true); // Force scroll on new message

            const startTime = Date.now();
            let firstTokenReceived = false;

            try {
              const headers = { 'Content-Type': 'application/json' };
              headers['X-Client-Source'] = 'web';
              if (config.apiKey) {
                headers['Authorization'] = `Bearer ${config.apiKey}`;
              }

              const payload = buildPayload(promptStr, mediaItems);

              const response = await fetch(`${config.apiBase}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: abortController.signal,
              });

              isConnected.value = true; // Connection successful
              if (reconnectInterval) {
                clearInterval(reconnectInterval);
                reconnectInterval = null;
              }

              if (!response.ok) {
                let errStr = `HTTP ${response.status}`;
                try {
                  const errJson = await response.json();
                  errStr += `: ${errJson.error?.message || JSON.stringify(errJson)}`;
                } catch {
                  errStr += `: ${response.statusText}`;
                }
                if (response.status === 413 || errStr.toLowerCase().includes('token')) {
                  throw new Error(`Token超限或请求过大 (${errStr})`);
                } else if (response.status === 503) {
                  throw new Error(`模型过载，请稍后重试 (${errStr})`);
                } else {
                  throw new Error(`网络或服务错误: ${errStr}`);
                }
              }

              const asyncIterable = parseSSE(response.body);
              for await (const chunk of asyncIterable) {
                if (!firstTokenReceived) {
                  firstTokenReceived = true;
                  messages.value[targetIndex].ttft = Date.now() - startTime;
                }

                if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
                  const delta = chunk.choices[0].delta;

                  // Handle DeepSeek/Qwen thinking model reasoning_content support
                  if (delta.reasoning_content) {
                    messages.value[targetIndex].thinking += delta.reasoning_content;
                    // Keep thinking area open if user opened it, or auto scroll
                    if (messages.value[targetIndex].showThinking) {
                      scrollToBottom();
                    }
                  }

                  if (delta.content) {
                    // Some Qwen models output <think> tags directly into the content stream
                    // instead of using reasoning_content. We need to intercept this.
                    let incomingContent = delta.content;

                    // If we are currently in thinking mode but receiving content, check if it's the start of <think>
                    if (
                      messages.value[targetIndex].isThinking &&
                      !messages.value[targetIndex].thinking &&
                      incomingContent.includes('<think>')
                    ) {
                      incomingContent = incomingContent.replace('<think>', '');
                      // We will route this to thinking instead of content
                    }

                    // If we don't have reasoning_content from the API, we manually parse <think> tags from content
                    // This is a simplified fallback: if we haven't seen a </think> yet, we append to thinking
                    if (
                      messages.value[targetIndex].isThinking &&
                      messages.value[targetIndex].content === ''
                    ) {
                      if (incomingContent.includes('</think>')) {
                        const parts = incomingContent.split('</think>');
                        messages.value[targetIndex].thinking += parts[0];
                        messages.value[targetIndex].isThinking = false;

                        if (parts[1]) {
                          appendAssistantContentBuffered(targetIndex, parts[1]);
                        }
                      } else {
                        messages.value[targetIndex].thinking += incomingContent;
                      }
                    } else {
                      // Once content starts, thinking is finished
                      if (messages.value[targetIndex].isThinking) {
                        messages.value[targetIndex].isThinking = false;
                      }
                      appendAssistantContentBuffered(targetIndex, incomingContent);
                    }
                    scrollToBottom();
                  }
                }

                if (chunk.usage) {
                  messages.value[targetIndex].usage = chunk.usage;
                  // In case there was no content, only reasoning, stop thinking state
                  messages.value[targetIndex].isThinking = false;
                }
              }
            } catch (err) {
              if (err.name === 'AbortError') {
                flushAssistantBuffer(targetIndex);
                messages.value[targetIndex].content += '\n\n*[已停止生成]*';
              } else {
                console.error(err);
                flushAssistantBuffer(targetIndex);
                messages.value[targetIndex].error = err.message || '请求超时或网络异常';

                // Handle connection failure and start auto-reconnect
                if (
                  err.message.includes('fetch') ||
                  err.message.includes('网络') ||
                  err.message.includes('timeout')
                ) {
                  isConnected.value = false;
                  startAutoReconnect();
                }
              }
            } finally {
              markAssistantBufferDone(targetIndex);

              // Always ensure thinking state is cleared when generation ends (normally, errored, or aborted)
              if (messages.value[targetIndex] && messages.value[targetIndex].isThinking) {
                messages.value[targetIndex].isThinking = false;
              }

              if (finalizeMessageRenderCache(targetIndex)) {
                const sessionsClone = JSON.parse(JSON.stringify(sessions.value));
                saveToIndexedDB(sessionsClone).catch((err) => {
                  console.error('Finalize render cache save failed', err);
                });
              }

              isGenerating.value = false;
              isRequestDispatching.value = false;
              abortController = null;
              scrollToBottom();
            }
          };

          const startAutoReconnect = () => {
            if (reconnectInterval) return;

            console.log('[Network] Connection lost. Attempting auto-reconnect every 5s...');
            reconnectInterval = setInterval(async () => {
              if (!config.apiKey) {
                return;
              }
              const connected = await api.reconnectProbe({
                apiBase: config.apiBase,
                apiKey: config.apiKey,
              });
              if (connected) {
                console.log('[Network] Reconnected successfully!');
                isConnected.value = true;
                clearInterval(reconnectInterval);
                reconnectInterval = null;
              }
            }, 5000);
          };

          const showExpandButton = computed(() => {
            // If the textarea has scrolled past a certain height, or contains more than 3 newlines
            const lineCount = (inputPrompt.value.match(/\n/g) || []).length + 1;
            return lineCount >= 3;
          });

          const textareaStyle = reactive({
            height: 'auto',
            overflowY: 'hidden',
          });

          const isTextareaExpanded = ref(false);

          const toggleTextareaExpand = () => {
            isTextareaExpanded.value = !isTextareaExpanded.value;
            nextTick(() => {
              adjustTextareaHeight();
            });
          };

          const adjustTextareaHeight = () => {
            const textarea = composerTextarea.value;
            if (textarea) {
              // Get current text lines
              // Temporarily reset height to get true scrollHeight
              textarea.style.height = 'auto';

              nextTick(() => {
                const scrollHeight = textarea.scrollHeight;

                // Base single line height is roughly 56px.
                // Max height for normal mode is roughly 7 lines (approx 192px).
                // Max height for expanded mode is roughly 23 lines (approx 550px).

                if (isTextareaExpanded.value) {
                  if (scrollHeight <= 550) {
                    textarea.style.height = scrollHeight + 'px';
                    textareaStyle.overflowY = 'hidden';
                  } else {
                    textarea.style.height = '550px';
                    textareaStyle.overflowY = 'auto';
                  }
                } else {
                  if (scrollHeight <= 192) {
                    textarea.style.height = scrollHeight + 'px';
                    textareaStyle.overflowY = 'hidden';
                  } else {
                    textarea.style.height = '192px';
                    textareaStyle.overflowY = 'auto';
                  }
                }
              });
            }
          };

          // Watch inputPrompt to adjust textarea height
          Vue.watch(inputPrompt, () => {
            nextTick(() => {
              adjustTextareaHeight();
            });
          });

          const sendMessage = () => {
            if (isGenerating.value || isRequestDispatching.value) return;

            const prompt = inputPrompt.value.trim();
            const mediaItems = [...pendingMedia.value]; // Copy current pending media

            if (!prompt && mediaItems.length === 0) return;

            inputPrompt.value = '';
            pendingMedia.value = []; // Clear pending media after sending

            nextTick(() => {
              adjustTextareaHeight();
              if (composerTextarea.value) {
                composerTextarea.value.focus();
              }
            });

            visibleStartIndex.value = Math.max(0, messages.value.length + 1 - WINDOW_SIZE);
            performRequest(prompt, mediaItems);
          };

          const retryMessage = (index) => {
            // Find the last user message before this assistant message
            let lastUserMsg = '';
            let lastUserMedia = [];
            for (let i = index - 1; i >= 0; i--) {
              if (messages.value[i].role === 'user') {
                lastUserMsg = messages.value[i].content;
                // If the original message had multimodal array, try to extract media
                if (Array.isArray(messages.value[i].rawContent)) {
                  // Simplify: For retry, we just re-send the text for now,
                  // properly re-sending base64 media can be memory intensive if stored in history
                }
                break;
              }
            }
            if (lastUserMsg) {
              performRequest(lastUserMsg, lastUserMedia, index);
            }
          };

          const copyToClipboard = async (msg) => {
            let textToCopy = msg.content;
            if (msg.role === 'assistant' && msg.thinking) {
              // Optionally include thinking process in copied text, or just the final response.
              // Usually users just want the final response.
              // If you want both: textToCopy = `[思考过程]\n${msg.thinking}\n\n[响应内容]\n${msg.content}`;
            }

            try {
              // Create a temporary textarea to handle formatting properly
              const textArea = document.createElement('textarea');
              textArea.value = textToCopy;
              // Avoid scrolling to bottom
              textArea.style.top = '0';
              textArea.style.left = '0';
              textArea.style.position = 'fixed';

              document.body.appendChild(textArea);
              textArea.focus();
              textArea.select();

              try {
                document.execCommand('copy');
                msg.copied = true;
                setTimeout(() => {
                  msg.copied = false;
                }, 2000);
              } catch (err) {
                console.error('Fallback: Oops, unable to copy', err);
              }

              document.body.removeChild(textArea);
            } catch (err) {
              console.error('Failed to copy text: ', err);
            }
          };

          return {
            initialized,
            config,
            agentTaskState,
            previewAgentTask,
            maxModelLenSourceLabel,
            loadModelInfoFromApi,
            params,
            activePreset,
            applyPreset,
            onParamChange,
            onMaxTokensCommit,
            sidebarOpen,
            settingsOpen,
            debouncedParamDisplay,
            settingsToggleRef,
            settingsPanelRef,
            settingsTitleRef,
            toggleSettingsPanel,
            closeSettingsPanel,
            currentSessionSystemPrompt,
            isSystemPromptLocked,
            updateSessionSystemPrompt,
            systemPromptTemplates,
            applySystemPromptTemplate,
            selectedTemplate,
            textareaStyle,
            showExpandButton,
            isTextareaExpanded,
            toggleTextareaExpand,
            multiTurn,
            initialForceScrollEnabled,
            setInitialForceScrollEnabled,
            sessions,
            currentSessionId,
            editingSessionId,
            editingSessionName,
            editInputRef,
            messages,
            visibleMessages,
            visibleStartIndex,
            createNewSession,
            switchSession,
            startEditSession,
            saveSessionName,
            deleteSession,
            inputPrompt,
            isGenerating,
            chatContainer,
            composerTextarea,
            activeMessageIndex,
            scrollToMessage,
            handleScroll,
            pendingMedia,
            mediaError,
            isConnected,
            isRecording,
            toggleVoiceInput,
            handleMediaUpload,
            removePendingMedia,
            sendMessage,
            clearCurrentChat,
            stopGeneration,
            renderMarkdown,
            retryMessage,
            copyToClipboard,
          };
        },
      }).mount('#app');
