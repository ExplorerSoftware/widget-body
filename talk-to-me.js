(function (window) {
    "use strict";
  
    class TalkToMeChat {
      constructor(config) {
        this.token = config.token;
        if (!this.token) {
          throw new Error('TalkToMe: token é obrigatório. Configure no constructor: new TalkToMeChat({ token: "..." })');
        }
        this.wsUrl = config.wsUrl
        this.theme = null;
        this.threadId = localStorage.getItem("ttm_thread_id") || null;
        this.ws = null;
        this.sessionId = this._generateSessionId();
        this.isOpen = false;
        this.userIdentifier = this._getUserIdentifier();
        this.container = null;
        this.chatWindow = null;
        this.messagesContainer = null;
        this.inputField = null;
        this.librariesLoaded = false;
        this.Motion = null;
        this.lucide = null;
        this.displayedMessages = new Set();
        this.messagesLoaded = false;
        this.pendingWebSocketMessages = [];
        this.messagesQueue = [];
        this.isProcessingQueue = false;
        this._unreadCount = 0;
        this._waitingForHistory = false;
        this.channelInactive = false;
      }
  
      async init() {
        await this._loadLibraries();
        
        this.theme = {
          theme: "dark",
          name: "Chat",
          bodyColor: "#151619",
          icon: "message-circle",
          logo_url: null,
          wallpaper_url: null,
        };
        
        this._createUI();
        this._connectWebSocket();
      }

      _generateSessionId() {
        return 'session_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
      }
  
      _getUserIdentifier() {
        let userId = localStorage.getItem("ttm_user_id");
        if (!userId) {
          userId = Math.random().toString(36).substring(2, 15);
          localStorage.setItem("ttm_user_id", userId);
        }
        return userId;
      }
  
      async _loadLibraries() {
        if (this.librariesLoaded) return;
  
        try {
          await Promise.all([this._loadTailwind(), this._loadFramerMotion(), this._loadLucide()]);
          this.librariesLoaded = true;
        } catch (error) {
          console.error("Erro ao carregar bibliotecas:", error);
        }
      }
  
      _loadTailwind() {
        return new Promise((resolve, reject) => {
          if (document.querySelector('script[src*="tailwindcss"]')) {
            resolve();
            return;
          }
          const script = document.createElement("script");
          script.src = "https://cdn.tailwindcss.com";
          script.onload = () => {
            if (window.tailwind) {
              window.tailwind.config = {
                corePlugins: {
                  preflight: false,
                },
              };
            }
            resolve();
          };
          script.onerror = () => reject(new Error("Falha ao carregar Tailwind CSS"));
          document.head.appendChild(script);
        });
      }
  
      _loadFramerMotion() {
        return new Promise((resolve, reject) => {
          if (window.Motion) {
            this.Motion = window.Motion;
            resolve();
            return;
          }
          const script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/npm/framer-motion@11/dist/framer-motion.js";
          script.onload = () => {
            this.Motion = window.Motion;
            resolve();
          };
          script.onerror = () => reject(new Error("Falha ao carregar Framer Motion"));
          document.head.appendChild(script);
        });
      }
  
      _loadLucide() {
        return new Promise((resolve, reject) => {
          if (window.lucide) {
            this.lucide = window.lucide;
            resolve();
            return;
          }
          const script = document.createElement("script");
          script.src = "https://unpkg.com/lucide@latest";
          script.onload = () => {
            this.lucide = window.lucide;
            resolve();
          };
          script.onerror = () => reject(new Error("Falha ao carregar Lucide"));
          document.head.appendChild(script);
        });
      }

      _connectWebSocket() {
        const wsUrl = `${this.wsUrl}/ws/session:${this.sessionId}/${this.threadId || 'new'}?token=${this.token}`;
      
        this.ws = new WebSocket(wsUrl);
        
        const connectionTimeout = setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
            console.error('TTM: Timeout na conexão WebSocket - Canal pode estar inativo');
            this.ws.close();
            this.ws = null;
            this.channelInactive = true;
            alert('Este canal de atendimento está temporariamente indisponível.');
          }
        }, 5000);
      
        this.ws.onopen = () => {
          clearTimeout(connectionTimeout);
          this.channelInactive = false;
          alert('TTM: WebSocket conectado com sucesso!');
          
          this._requestMetadata();
          
          if (!this.messagesLoaded) {
            this._loadMessages();
          }
        };
      
        this.ws.onerror = (e) => {
          clearTimeout(connectionTimeout);
          console.error('TTM: WS error:', e);
        };
      
        this.ws.onclose = (e) => {
          clearTimeout(connectionTimeout);
          console.log('TTM: WebSocket fechado. Código: ' + e.code);
      
          if (e.code >= 4000 && e.code <= 4999) {
              this.channelInactive = true;
              this.ws = null;
      
              if (e.code === 4003) {
                  alert('Este canal de atendimento está inativo ou foi desativado.');
              } else {
                  alert('Não foi possível conectar. Canal indisponível.');
              }
              return;
          }

          this.ws = null;
      };
      
        this.ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          alert('TTM: Mensagem recebida - Tipo: ' + data.type);
          
          if (data.type === "metadata" && data.data) {
            this._handleMetadata(data.data);
            return;
          }
          
          if (data.type === "error") {
            console.error('TTM Error:', data.error);
            alert('TTM Error: ' + data.error);
            return;
          }
          
          if (data.type === "history" && data.data) {
            const threadId = data.data.id;
            if (threadId) {
              this.threadId = threadId;
              localStorage.setItem("ttm_thread_id", this.threadId);
            }
            if (data.data.messages && Array.isArray(data.data.messages)) {
              data.data.messages.forEach(message => {
                this.pendingWebSocketMessages.push(message);
              });
            }
            
            this._waitingForHistory = false;
            return;
          }
      
          if (data.type === "message" && data.data) {
            const message = data.data;
            const threadId = message.thread_id;
            if (threadId) {
              this.threadId = threadId;
              localStorage.setItem("ttm_thread_id", this.threadId);
            }
            if (this.messagesLoaded) {
              this._enqueueMessage(message, true);
      
              if (!this.isOpen && message.origin !== "customer") {
                this._unreadCount++;
                this._updateNotificationCounter();
              }
            } else {
              this.pendingWebSocketMessages.push(message);
            }
          }
      
          if (data.type === "finish") {
            this._clearThreadData();
            this._closeWebSocket();
            this._connectWebSocket();
          }
        };
      }
      
      _requestMetadata() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: "metadata",
            data: {
              token: this.token
            }
          }));
        }
      }
      
      _handleMetadata(metadata) {
        this.config = {
          name: metadata.name,
          ...metadata.data,
          metadata: metadata.data,
          widget_style: metadata.data.widget_style
        };
        
        console.log('TTM: Configuração carregada via WebSocket', this.config);
        

        if (this.config.widget_style) {
          this._applyWidgetStyles(this.config.widget_style);
        }
      }

      _applyWidgetStyles(widgetStyle) {
        this.theme = {
          ...this.theme,
          ...widgetStyle,
          name: this.config.name || this.theme.name,
          theme: widgetStyle.theme || this.theme.theme,
          bodyColor: widgetStyle.bodyColor || this.theme.bodyColor,
          headerColor: widgetStyle.headerColor || this.theme.headerColor,
          buttonColor: widgetStyle.buttonColor || this.theme.buttonColor,
          link: widgetStyle.link || this.theme.link,
          link_label: widgetStyle.link_label || this.theme.link_label,
          icon: widgetStyle.icon || this.theme.icon,
          logos_url: widgetStyle.logos || this.theme.logos_url,
          wallpaper_url: widgetStyle.wallpaper || this.theme.wallpaper_url,
        };
        
        this._updateUIWithNewTheme();
        
        const isDark = this.theme.theme === "dark";

        if (this.chatWindow && this.theme.buttonColor) {
          this.chatWindow.style.background = this.theme.buttonColor;
        }

        
        const header = this.chatContent?.querySelector('.p-1.flex.items-start.gap-2');
        if (header) {
          header.style.background = this.theme.headerColor;
          const isDark = this.theme.theme === "dark";

          const titleElement = header.querySelector('h3');

          const existingAvatars = header.querySelectorAll('.mt-1.w-\\[2\\.5rem\\].h-\\[2\\.5rem\\].rounded-full.border-2');
          existingAvatars.forEach(avatar => {
            avatar.remove();
          });

          if (Array.isArray(this.theme.logos_url) && this.theme.logos_url.length > 0) {

            const avatarsContainer = document.createElement('div');
            avatarsContainer.className = 'flex ml-[10px] items-center';
            avatarsContainer.style.marginTop = '0.25rem';
            
            this.theme.logos_url.forEach((logo, index) => {
              const avatarDiv = document.createElement('div');
              avatarDiv.className = 'w-[2.5rem] h-[2.5rem] rounded-full border-2 flex items-center justify-center flex-shrink-0';
              avatarDiv.style.background = isDark ? '#494949' : '#d4d4d4';

              if (index > 0) {
                avatarDiv.style.marginLeft = '-14px';
              }
              
              const img = document.createElement('img');
              img.src = logo;
              img.alt = 'Logo';
              img.className = 'w-[2.5rem] h-[2.5rem] rounded-full object-cover';
              avatarDiv.appendChild(img);

              avatarsContainer.appendChild(avatarDiv);
            });

            if (titleElement) {
              header.insertBefore(avatarsContainer, titleElement);
            } else {
              header.appendChild(avatarsContainer);
            }
          } else {
            const avatarDiv = document.createElement('div');
            avatarDiv.className = 'mt-1 ml-3 w-[2.5rem] h-[2.5rem] rounded-full border-2 flex items-center justify-center flex-shrink-0';
            avatarDiv.style.background = isDark ? '#494949' : '#d4d4d4';
            avatarDiv.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${isDark ? '#ffffff' : '#000000'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-5"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>
            `;

            if (titleElement) {
              header.insertBefore(avatarDiv, titleElement);
            } else {
              header.appendChild(avatarDiv);
            }
          }
        }
        
        const messagesArea = this.chatContent?.querySelector('.flex-1.flex.overflow-y-auto');
        if (messagesArea) {
          if (this.theme.wallpaper_url) {
            messagesArea.style.backgroundImage = `url(${this.theme.wallpaper_url})`;
            messagesArea.style.backgroundSize = 'cover';
            messagesArea.style.backgroundPosition = 'center';
          } else {
            messagesArea.style.background = this.theme.bodyColor;
          }
        }
        
        const inputContainer = this.chatContent?.querySelector('.flex.flex-col.p-1.gap-0');
        if (inputContainer) {
          inputContainer.style.background = isDark ? '#212224' : '#e9e9e9';
        }
        
        if (this.inputField) {
          this.inputField.style.bodyColor = isDark ? '#ffffff' : '#000000';
        }
        
        if (this.sendButton) {
          this.sendButton.style.background = isDark ? '#ffffff' : '#000000';
          const sendButtonIcon = this.sendButton.querySelector('svg');
          if (sendButtonIcon) {
              sendButtonIcon.style.stroke = isDark ? '#000000' : '#ffffff';
              sendButtonIcon.style.color = isDark ? '#000000' : '#ffffff';
          }
        }
        
        const inputContainerParent = inputContainer?.parentElement;
        
        if (inputContainerParent) {
          const existingLinkContainer = inputContainerParent.querySelector('.ttm-link-container');
          if (existingLinkContainer) {
            existingLinkContainer.remove();
          }
          

          if (this.theme.link && this.theme.link_label) {
            const linkContainer = document.createElement('div');
            linkContainer.className = 'ttm-link-container flex flex-row items-center justify-center rounded-lg mt-2 px-2 py-1 mx-auto w-fit gap-2';
            linkContainer.style.background = isDark ? '#212223' : '#e9e9e9';
            linkContainer.innerHTML = `
              <i data-lucide="link" style="width: 16px; height: 16px; color: ${isDark ? '#ffffff' : '#000000'};"></i>
              <a href="${this.theme.link}" target="_blank" class="text-sm" style="color: ${isDark ? '#ffffff' : '#000000'}; text-decoration: none;">
                ${this.theme.link_label}
              </a>
            `;
            inputContainerParent.appendChild(linkContainer);
            this.lucide?.createIcons();
          }
        }
        
        if (this.lucide) {
          this.lucide.createIcons();
        }
      }

      async _sendMessage(textOverride = null, files = null) {
        const text = textOverride || this.inputField.value;
        const origin = window.location.hostname || window.location.host || '';
        const username = `user_${this.userIdentifier}_${origin}`;
        
        if (!text) return;

        if (this.channelInactive) {
          alert('Este canal de atendimento está inativo. Não é possível enviar mensagens.');
          return;
        }

        if (!textOverride) {
          this.inputField.value = "";
          this.inputField.style.height = "auto";
          this._updateSendButtonIcon();
        }
  
        if (text) {
          const userMessage = {
            text: text || null,
            origin: "customer",
            created_at: new Date().toISOString(),
            timestamp: new Date().getTime(),
          }
          this._enqueueMessage(userMessage);
          this._processMessageQueue();
        }
  
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          if (!this.channelInactive) {
            this._connectWebSocket();
            await new Promise(resolve => setTimeout(resolve, 1000));
          } else {
            console.log('TTM: Não conectando - canal inativo');
            return;
          }
        }

        this.ws.send(JSON.stringify({
          type: 'send_message',
          data: {
            token: this.token,
            name: username,
            user_id: this.userIdentifier,
            text: text || null,
            metadata: {
              origin: origin
            },
            thread_id: this.threadId
          }
        }));
      }

      _initAudioPlayers() {
          document.querySelectorAll('.ttm-audio-player').forEach(async (player) => {
          const playBtn = player.querySelector('.ttm-audio-play-btn');
          const audioElement = player.querySelector('.ttm-audio-element');
          const progressBar = player.querySelector('.ttm-audio-waveform');
          const currentTimeEl = player.querySelector('.ttm-audio-current-time');
          const durationEl = player.querySelector('.ttm-audio-duration');
          const isTalkToMe = player.closest('.ttm-message-talk-to-me');
          const isCustomer = player.closest('.ttm-message-customer');
  
  
          if (player.dataset.waveformProcessed) return;
          player.dataset.waveformProcessed = 'true';
  
          const firstBar = progressBar.querySelector('.ttm-waveform-bar');
          const barBg = window.getComputedStyle(firstBar).backgroundColor;
          const isDark = barBg.includes('0, 0, 0') || barBg.includes('rgb(0');
  
          let isPlaying = false;
  
          const audioUrl = audioElement.querySelector('source').src;
          const waveformData = await this._generateWaveformData(audioUrl, 30);
  
          const backgroundBars = progressBar.querySelectorAll('.ttm-waveform-bar');
  
          waveformData.forEach((height, index) => {
              if (backgroundBars[index]) {
                  backgroundBars[index].style.height = `${height}%`;
              }
          });
  
          const formatTime = (seconds) => {
              const mins = Math.floor(seconds / 60);
              const secs = Math.floor(seconds % 60);
              return `${mins}:${secs.toString().padStart(2, '0')}`;
          };
  
          audioElement.load();
  
          audioElement.addEventListener('loadedmetadata', () => {
              durationEl.textContent = formatTime(audioElement.duration);
          });
  
          audioElement.addEventListener('timeupdate', () => {
              const progress = (audioElement.currentTime / audioElement.duration) * 100;
              const bars = progressBar.querySelectorAll('.ttm-waveform-bar');
              const barsToFill = Math.floor((progress / 100) * bars.length);
  
              bars.forEach((bar, index) => {
                if (index < barsToFill) {
                    bar.style.background = isTalkToMe ? (isDark ? '#ffffff' : '#000000') : (isCustomer ? (isDark ? '#000000' : '#ffffff') : '#909090');
                } else {
                    bar.style.background = '#909090';
                }
            });
              currentTimeEl.textContent = formatTime(audioElement.currentTime);
          });
  
          audioElement.addEventListener('ended', () => {
              isPlaying = false;
              const playIcon = playBtn.querySelector('i, svg');
              if (playIcon) {
                  playIcon.setAttribute('data-lucide', 'play');
                  playIcon.style.marginLeft = '2px';
              }
  
              const bars = progressBar.querySelectorAll('.ttm-waveform-bar');
              bars.forEach(bar => {
                  bar.style.background = '#909090';
              });
  
              currentTimeEl.textContent = '0:00';
              this.lucide.createIcons();
          });
  
          playBtn.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
  
              const playIcon = playBtn.querySelector('i, svg');
  
              if (isPlaying) {
                  audioElement.pause();
                  playIcon.setAttribute('data-lucide', 'play');
                  playIcon.style.marginLeft = '2px';
              } else {
                  document.querySelectorAll('.ttm-audio-element').forEach(audio => {
                      if (audio !== audioElement) {
                          audio.pause();
                          const otherPlayBtn = audio.closest('.ttm-audio-player').querySelector('.ttm-audio-play-btn');
                          const otherIcon = otherPlayBtn.querySelector('i, svg');
                          if (otherIcon) {
                              otherIcon.setAttribute('data-lucide', 'play');
                              otherIcon.style.marginLeft = '2px';
                          }
                      }
                  });
  
                  audioElement.play();
                  playIcon.setAttribute('data-lucide', 'pause');
                  playIcon.style.marginLeft = '0';
              }
  
              isPlaying = !isPlaying;
              this.lucide.createIcons();
          });
  
              progressBar.addEventListener('click', (e) => {
                  const rect = progressBar.getBoundingClientRect();
                  const percent = (e.clientX - rect.left) / rect.width;
                  audioElement.currentTime = percent * audioElement.duration;
              });
          });
      }

      async _generateWaveformData(audioUrl, barCount = 30) {
            const response = await fetch(audioUrl);
            const arrayBuffer = await response.arrayBuffer();
  
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  
            const rawData = audioBuffer.getChannelData(0);
            const samples = barCount;
            const blockSize = Math.floor(rawData.length / samples);
            const filteredData = [];
  
            for (let i = 0; i < samples; i++) {
              let blockStart = blockSize * i;
              let sum = 0;
              for (let j = 0; j < blockSize; j++) {
                sum += Math.abs(rawData[blockStart + j]);
              }
              filteredData.push(sum / blockSize);
            }
  
            const max = Math.max(...filteredData);
            const min = Math.min(...filteredData);
            const range = max - min;
  
            const normalizedData = filteredData.map(val => {
              if (range === 0) return 20;
              const normalized = ((val - min) / range);
              return Math.floor(normalized * 60) + 20;
            });
  
            audioContext.close();
            return normalizedData;
        }

      _audioRecorder(stream) {
          const mimeTypes = [
              'audio/ogg; codecs=opus',
              'audio/webm; codecs=opus',
              'audio/webm'
            ];
  
          const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type)) || '';
  
          const audioRecorder = new MediaRecorder(stream, { mimeType });
  
          let recordingSeconds = 0;
          this.recordingInterval = setInterval(() => {
            recordingSeconds++;
            const mins = Math.floor(recordingSeconds / 60);
            const secs = recordingSeconds % 60;
            const time = `${mins}:${secs.toString().padStart(2, '0')}`;
            this._setRecordingButtonStyle(true, time);
          }, 1000);
  
          this._setRecordingButtonStyle(true, '0:00');
  
          audioRecorder.addEventListener("dataavailable", (e) => {
              if (e.data.size > 0) {
                  const extension = mimeType.includes('ogg') ? 'ogg' : 'webm';
                  const file = new File([e.data], `audio.${extension}`, { type: mimeType })
                  this._sendMessage(null, [file])
              }
          })
  
          audioRecorder.addEventListener("stop", () => {
  
            if (this.recordingInterval) {
              clearInterval(this.recordingInterval);
              this.recordingInterval = null;
            }
  
            this._setRecordingButtonStyle(false, '0:00');
            this.activeRecorder = null;
            stream.getTracks().forEach(track => track.stop());
            this.audioStream = null;
          })
          audioRecorder.start()
          return audioRecorder
        }

      _setRecordingButtonStyle(isRecording, recordingTime = '0:00') {
        if (!this.sendButton) return;
  
        const isDark = this.theme.theme === "dark";
  
        if (isRecording) {
  
          if (!this.originalPlaceholder) {
            this.originalPlaceholder = this.inputField.placeholder;
          }
  
            this.sendButton.style.background = '#ef4444';
            this.sendButton.style.animation = 'ttm-pulse 1.5s ease-in-out infinite';
            this.sendButton.innerHTML = `<i data-lucide="stop" style="width: 16px; height: 16px; color: #ffffff;"></i>`;
            this.inputField.placeholder = `Gravando... ${recordingTime}`;
  
        } else {
            this.sendButton.style.background = isDark ? "#ffffff" : "#000000";
            this.sendButton.style.border = "none";
            this.sendButton.style.animation = "";
  
            if (this.originalPlaceholder) {
              this.inputField.placeholder = this.originalPlaceholder;
              this.originalPlaceholder = null;
            }
  
            this._updateSendButtonIcon(); 
        }
        this.lucide.createIcons();
        const stopIcon = this.sendButton.querySelector('svg');
        if (stopIcon) {
            stopIcon.style.stroke = '#ffffff';
            stopIcon.style.color = '#ffffff';
        }
      }

      _closeWebSocket() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close();
        }
        this.ws = null;
      }

      _clearThreadData() {
        localStorage.removeItem("ttm_thread_id");
        localStorage.removeItem("ttm_user_id");

        this.threadId = null;
        this.messagesLoaded = false;
        this.displayedMessages.clear();
        this.messagesQueue = [];
        this.pendingWebSocketMessages = [];
        this.userIdentifier = this._getUserIdentifier();

        this._updateNotificationCounter();
  
        if (this.messagesContainer) {
          this.messagesContainer.innerHTML = "";
        }
      }

      async _loadMessages() {
        if (this.messagesLoaded) return;

        if (this.threadId && this.ws && this.ws.readyState === WebSocket.OPEN) {

          this._waitingForHistory = true;
          
          this.ws.send(JSON.stringify({
            type: 'history',
            data: {
              thread_id: this.threadId,
              token: this.token
            }
          }));

          const maxWait = 3000;
          const startTime = Date.now();
          
          while (this._waitingForHistory && (Date.now() - startTime) < maxWait) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        this.messagesLoaded = true;
        this._processPendingMessages();
      }

      async _processMessageQueue() {
        if (this.isProcessingQueue || this.messagesQueue.length === 0) {
          return;
        } 
  
        this.isProcessingQueue = true;
  
        while (this.messagesQueue.length > 0) {
          const message = this.messagesQueue.shift();
          this._displayMessage(message);
  
          if (message.isNewMessage) {
          await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        this.isProcessingQueue = false;
      }

      _enqueueMessage(message, isNewMessage = false) {
        const messageKey = `${message.text || ''}_${message.origin}_${message.created_at || message.timestamp || ''}`;
  
        if (this.displayedMessages.has(messageKey)) {
          return;
        }
  
        this.displayedMessages.add(messageKey);
  
        message.isNewMessage = isNewMessage;
  
        this.messagesQueue.push(message);
        this._processMessageQueue();
      }

      _notification() {
          const counter = document.querySelector('.ttm-notification-counter');
          if (counter) {
            const count = this._unreadCount || 0;
              if (count > 0) {
              counter.querySelector('span').textContent = count;
              counter.classList.remove('hidden');
              } else {   
                counter.classList.add('hidden');
              }
          }
      }

      _updateNotificationCounter() {
        const counter = document.querySelector('.ttm-notification-counter');
        if (counter) {
          const count = this._unreadCount || 0;
          if (count > 0) {
            counter.querySelector('span').textContent = count;
            counter.classList.remove('hidden');
          } else {
            counter.classList.add('hidden');
          }
        }
      }

      _resetNotificationCounter() {
        this._unreadCount = 0;
        this._updateNotificationCounter();
      }

      _processPendingMessages() {
        if (this.pendingWebSocketMessages.length > 0) {
          this.pendingWebSocketMessages.forEach(message => {
            this._enqueueMessage(message);
          });
          this.pendingWebSocketMessages = [];
        }
      }

      _createUI() {
            const isDark = this.theme.theme === "dark";
            this._injectCustomStyles();
            this.container = document.createElement("div");
            this.container.id = "ttm-chat-container";
            this._visualizer();

            const iconName = this.theme.icon || "message-circle";

            this.container.innerHTML = `
                    <div
                    id="ttm-chat-window"
                    class="fixed flex flex-col border-2 shadow-2xl cursor-pointer"
                    style="
                        background: ${this.theme.buttonColor};
                        bottom: 20px;
                        right: 20px;
                        border-radius: 24px;
                        z-index: 9999;
                        border: none;
                        width: 46px;
                        height: 46px;
                    "
                    aria-label="Abrir chat"
                    >
                    <div
                        id="ttm-button-icon"
                        type="button"
                        class="absolute inset-0 flex items-center justify-center"
                        style="opacity: 1;"
                    >
                        <i
                        data-lucide="${iconName}"
                        class="size-5"
                        style="color: ${isDark ? '#ffffff' : '#000000'};"
                        ></i>
                    </div>
                    <div class="ttm-notification-counter absolute min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 hidden flex items-center justify-center border-2 border-white" style="top: -4px; right: 4px; z-index: 10000; transform: translate(6px, -6px);">
                        <span class="text-[11px] text-white font-semibold leading-none">0</span>
                    </div>
                    <div
                        id="ttm-chat-content"
                        class="flex flex-col h-full"
                        style="opacity: 0; pointer-events: none; display: none; position: relative;"
                        >
                        <div
                        class="p-1 flex items-start gap-2 flex-shrink-0"
                        style="background: ${this.theme.headerColor};  border-bottom: 1px solid ${isDark ? '#565656' : '#d1d5db'};"
                        >
                  
                    <h3
                        class="flex-1 text-base font-normal mt-[0.9rem] ml-1"
                        style="color: ${isDark ? 'white' : 'black'};"
                    >
                        ${this.theme.name}
                    </h3>
                    <button
                        id="ttm-close-button"
                        class="w-9 h-9 bg-transparent flex items-center justify-center self-end m-1.5 border-none cursor-pointer transition-opacity hover:opacity-90 flex-shrink-0"
                        aria-label="Fechar chat"
                    >
                        <i 
                        data-lucide="x" 
                        style="width: 16px; height: 16px; color: ${isDark ? '#ffffff' : '#000000'};"
                        ></i>
                    </button>
                    </div>
                    <div
                    class="flex-1 flex overflow-y-auto flex-col"
                    style="${this.theme.wallpaper_url ? `background-image: url(${this.theme.wallpaper_url}); background-size: cover; background-position: center;` : this.theme.bodyColor ? `background: ${this.theme.bodyColor};` : ''}"
                    >
                    <div
                        id="ttm-messages"
                        class="flex-1 p-2  flex flex-col gap-2 bg-transparent"
                    >
                    </div>
                    <div class="p-2 flex-shrink-0">
                        <div
                        class="flex flex-col p-1 gap-0 border-2 rounded-[1rem]"
                        style="background: ${isDark ? '#212224' : '#e9e9e9'}; border: none;"
                        >
                        <textarea
                            type="text"
                            id="ttm-input"
                            class="flex p-1 w-full border-none bg-transparent h-[36px] resize-none max-h-[100px] line-height-1.5 overflow-y-auto outline-none text-sm"
                            style="
                            color: ${isDark ? '#ffffff' : '#000000'};
                            padding-top: 10px;
                            padding-left: 1rem;
                            box-sizing: border-box;
                            "
                            placeholder="Digite aqui sua mensagem..."
                            maxlength="1000"
                        ></textarea>
                        <div class="flex flex-row items-center justify-between w-full gap-2">
                            <div class="flex-1"></div>
                            <button
                            id="ttm-send-button"
                            type="button"
                            class="w-8 h-8 rounded-full flex items-center justify-center self-end m-1.5 border-none cursor-pointer transition-opacity hover:opacity-90 flex-shrink-0"
                            style="background: ${isDark ? '#ffffff' : '#000000'};"
                            aria-label="Enviar mensagem"
                            >
                            <i 
                                data-lucide="arrow-up" 
                                style="width: 16px; height: 16px; color: ${isDark ? '#000000' : '#ffffff'};"
                            ></i>
                            </button>
                        </div>
                        </div>
                    </div>
                    </div>
                </div>
                </div>
            `;

                document.body.appendChild(this.container);

                this.chatWindow = document.getElementById("ttm-chat-window");
                this.buttonIcon = document.getElementById("ttm-button-icon");
                this.inputField = document.getElementById("ttm-input");
                this.chatContent = document.getElementById("ttm-chat-content");
                this.sendButton = document.getElementById("ttm-send-button");
                this.messagesContainer = document.getElementById("ttm-messages");
                this.closeButton = document.getElementById("ttm-close-button"); 
                this.audioStream = null;

                this.lucide.createIcons();

                this.chatWindow.addEventListener("click", (e) => {
                    if (!this.isOpen) {
                    this._openChat();
                    }
                });

                this.closeButton.addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this._closeChat();
                });

                this.sendButton?.addEventListener("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const hasText = this.inputField?.value.length > 0;

                    if (hasText) {
                        this._sendMessage();
                    return;
                    }
                });

                this.inputField?.addEventListener("keypress", (e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                        this._sendMessage();
                    }
                });  

                this.inputField?.addEventListener("input", (e) => {
                    e.target.style.height = "30px";
                    const newHeight = Math.min(e.target.scrollHeight, 100);
                    e.target.style.height = newHeight + "px";
                    this._updateSendButtonIcon();
                });
            }

      _updateSendButtonIcon() {
            const hasText = this.inputField?.value.length > 0;
            this.lucide.createIcons();
            }

      _visualizer() {
            const visualizerOverlay = document.createElement('div');
            visualizerOverlay.id = 'ttm-visualizer-overlay';
            visualizerOverlay.className = 'ttm-visualizer-overlay fixed top-0 left-0 w-[100vw] h-[100vh] z-[99999] bg-black/70 backdrop-blur-md justify-center items-center ';
            visualizerOverlay.style.cssText = `
                display: none;
            `;

            const visualizerContainer = document.createElement('div');
            visualizerContainer.id = 'ttm-visualizer-container';
            visualizerContainer.className = 'ttm-visualizer-container relative max-w-[90vw] max-h-[90vh]  flex justify-center items-center';

            const closeButton = document.createElement('button');
            closeButton.id = 'ttm-visualizer-close-button';
            closeButton.className = 'ttm-visualizer-close-button fixed top-[10px] right-[10px] w-[40px] h-[40px] rounded-full border-none bg-transparent flex p-0  z-[100000] items-center justify-center cursor-pointer';
            closeButton.innerHTML = '<i data-lucide="x" style="width: 24px; height: 24px; color: #ffffff;"></i>';


            const mediaContainer = document.createElement('div');
            mediaContainer.id = 'ttm-visualizer-media-container';
            mediaContainer.className = 'ttm-visualizer-media-container relative w-[100%] h-[100%] flex justify-center items-center';

            visualizerContainer.appendChild(closeButton);
            visualizerContainer.appendChild(mediaContainer);
            visualizerOverlay.appendChild(visualizerContainer);
            document.body.appendChild(visualizerOverlay);

            this.openVisualizer = (src) => {
                mediaContainer.innerHTML = '';
                const img = document.createElement('img');
                img.src = src;
                img.style.cssText = `
                min-width: 70px;
                min-height: 70px;
                max-width: 100%;
                max-height: 90vh;
                border-radius: 8px;
                object-fit: contain;
                `;
                mediaContainer.appendChild(img);
                visualizerOverlay.style.display = 'flex';
                this.lucide.createIcons();
            };

            closeButton.addEventListener('click', () => {
                visualizerOverlay.style.display = 'none';
            });

            visualizerOverlay.addEventListener('click', (e) => {
                if (e.target === visualizerOverlay) {
                visualizerOverlay.style.display = 'none';
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && visualizerOverlay.style.display === 'flex') {
                visualizerOverlay.style.display = 'none';
                }
            })

            document.addEventListener('click', (e) => {
                if (e.target.classList.contains('ttm-media-visualizer')) {
                if (e.target.tagName === 'VIDEO') {
                    return;
                }
                const mediaSrc = e.target.dataset.mediaSrc;
                const mediaType = e.target.dataset.mediaType;
                if (mediaSrc && mediaType) {
                    this.openVisualizer(mediaSrc, mediaType);
                }
                }
            })
            }

      _injectCustomStyles() {
            const isDark = this.theme.theme === "dark";

            const styles = `
                #ttm-chat-container * {
                box-sizing: border-box;
                }
        
                @keyframes ttm-slide-in {
                from {
                    opacity: 0;
                    transform: translateY(10px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
                }
                @keyframes ttm-pulse {
                0% {
                    transform: scale(1);
                }
                50% {
                    transform: scale(1.1);
                }
                100% {
                    transform: scale(1);
                }
                }
        
                .ttm-message-customer {
                display: flex;
                justify-content: flex-end !important;
                }
                #ttm-drop-zone.ttm-drag-over {
                border-color: #3b82f6 !important;
                background: ${isDark ? "#1e3a5f" : "#dbeafe"} !important;
                transform: scale(1.02);
                transition: all 0.2s ease;
                }
                #ttm-drop-zone {
                transition: all 0.2s ease;
                }
                @keyframes ttm-drag-pulse {
                    0%, 100% {
                        opacity: 1;
                    }
                    50% {
                        opacity: 0.8;
                    }
                }
                #ttm-drop-zone.ttm-drag-over {
                animation: ttm-drag-pulse 1s ease-in-out infinite;
                }
                .ttm-message {
                pointer-events: auto;
                touch-action: pan-y;
                animation: ttm-slide-in 0.3s ease-in-out;
                }
                #ttm-input {
                box-sizing: border-box !important;
                overflow-y: auto !important;
                }
        
                #ttm-input::placeholder {
                color: ${isDark ? "#e5e7eb" : "#cacaca"};
                }
        
                #ttm-messages::-webkit-scrollbar {
                width: 6px;
                }
                #ttm-messages::-webkit-scrollbar-thumb {
                background: ${isDark ? "#404040" : "#d1d5db"};
                border-radius: 3px;
                }
                #ttm-messages {
                -webkit-overflow-scrolling: touch;
                overscroll-behavior: contain;
                touch-action: pan-y;
                overflow-y: scroll !important;
                -webkit-transform: translateZ(0);
                }
        
                #ttm-input::-webkit-scrollbar {
                width: 8px;
                }
        
                #ttm-input::-webkit-scrollbar-track {
                background: transparent;
                border-radius: 4px;
                }
        
                #ttm-input::-webkit-scrollbar-thumb {
                background: ${isDark ? "#666" : "#888"};
                border-radius: 4px;
                }
        
                @media (max-width: 480px) {
                #ttm-chat-window[data-open="true"] {
                    width: calc(100vw - 20px) !important;
                    height: calc(100vh - 100px) !important;
                    right: 10px !important;
                }
                }
        
                [data-lucide] {
                display: inline-block;
                }
            `;

            const styleSheet = document.createElement("style");
            styleSheet.textContent = styles;
            document.head.appendChild(styleSheet);
            }

      _openChat() {
            this.isOpen = true;
            this.chatWindow.classList.add('overflow-hidden');
            this.chatWindow.setAttribute("data-open", "true");
            this.chatWindow.style.cursor = "default";
            this.buttonIcon.style.opacity = "0";
            this.buttonIcon.style.display = "none";
            this.chatContent.style.display = "flex";
            this.chatWindow.style.transition = "all 0.35s ease";
            this.chatWindow.style.width = "343px";
            this.chatWindow.style.height = "550px";
            this.chatWindow.style.borderRadius = "14px";
            this.chatContent.style.opacity = "1";
            this.chatContent.style.pointerEvents = "auto";
            this._resetNotificationCounter();

            if (!this.ws && !this.channelInactive) {
                this._connectWebSocket();
            }
            }

      _closeChat() {
            this.isOpen = false;
            this.chatWindow.setAttribute("data-open", "false");
            this.chatWindow.style.cursor = "pointer";
            this.chatContent.style.opacity = "0";
            this.chatContent.style.pointerEvents = "none";
            this.chatContent.style.display = "none";
            this.buttonIcon.style.display = "flex";
            this.buttonIcon.style.opacity = "1";
            this.chatWindow.style.width = "44px";
            this.chatWindow.style.height = "44px";
            this.chatWindow.style.borderRadius = "24px";
            this.chatWindow.classList.remove('overflow-hidden');
            this.lucide.createIcons();

            if (this.activeRecorder && this.activeRecorder.state === 'recording') {
                this.activeRecorder.stop();
                this.activeRecorder = null;
            }

            this.dragCounter = 0;
            if (this.dragTimeout) {
                clearTimeout(this.dragTimeout);
                this.dragTimeout = null;
            }
        }

      _updateUIWithNewTheme() {
        if (!this.container || !this.theme) return;
        
        const isDark = this.theme.theme === "dark";
        const iconName = this.theme.icon || "message-circle";
        
        const iconElement = this.buttonIcon?.querySelector('[data-lucide]');
        if (iconElement) {
          iconElement.setAttribute('data-lucide', iconName);
          iconElement.style.color = isDark ? '#ffffff' : '#000000';
          this.lucide?.createIcons();
        }
        
        const header = this.chatContent?.querySelector('.p-1');
        if (header) {
          header.style.background = this.theme.headerColor;
        }
        
        if (this.theme.logo_url) {
          const logoImg = this.chatContent?.querySelector('img[alt="Logo"]');
          if (logoImg) {
            logoImg.src = this.theme.logo_url;
          }
        }

        const nameElement = this.chatContent?.querySelector('h3');
        if (nameElement) {
          nameElement.textContent = this.theme.name || "Chat";
        }
      }

      _displayMessage(message) {
        const isDark = this.theme.theme === "dark";
        const isCustomer = message.origin === "customer";
        const isTalkToMe = message.origin != "customer";

        const messageElement = document.createElement("div");

        messageElement.className = `ttm-message ${isCustomer ? "ttm-message-customer" : "ttm-message-agent"} ${isTalkToMe ? "ttm-message-talk-to-me" : ""}`;

        const bubbleColor = isTalkToMe ? (isDark ? "#000000" : "#ebeaea") : (isCustomer ? (isDark ? "#ffffff" : "#000000") : "#000000"); 
        const textColor = isTalkToMe ? (isDark ? "#ffffff" : "#000000") : (isCustomer ? (isDark ? "#000000" : "#ffffff") : "#000000");  

        messageElement.innerHTML = `
            <div 
            class="relative w-fit max-w-[80%] h-full rounded-xl px-2 py-2 break-words"
            style="
                background: ${bubbleColor};
                color: ${textColor};
                ${isCustomer ? `border: solid 1px ${isDark ? '#d1d5db' : 'transparent'};` : ""}
                ${isTalkToMe ? `border: solid 1px ${isDark ? 'transparent' : '#d1d5db'};` : ""}
            "
            >
            ${message.media?.content_type?.startsWith("image") ? `
            <img 
                src="${message.media.file}" 
                alt="Preview da imagem" 
                class="w-full max-w-[280px] h-auto ttm-media-visualizer cursor-pointer rounded-md object-cover" 
                data-media-src="${message.media.file}"
                data-media-type="image"
            />
            ` : ""}
            ${message.media?.content_type?.startsWith("video") ? `
                <video 
                src="${message.media.file}" 
                alt="Preview do vídeo" 
                class="w-full max-w-[280px] h-auto ttm-media-visualizer cursor-pointer rounded-md object-cover" 
                data-media-src="${message.media.file}"
                data-media-type="video"
                controls
                >
                </video>
            ` : ""}
            ${message.media?.content_type?.startsWith("audio") ? `
            <div class="ttm-audio-player " 
                style="
                    width: 220px; 
                    border-radius: 8px;
                    display: flex;
                    justify-content: start;
                    align-items: center;
                    gap: 6px;
                    background: transparent;
            ">
                <button 
                class="ttm-audio-play-btn border-none w-[32px] h-[32px] rounded-full flex items-center justify-center" 
                data-audio-src="${message.media.file}"
                style="
                    background: ${isTalkToMe ? (isDark ? "#ffffff" : "#000000") : isCustomer ? (isDark ? "#1a1a1a" : "#ffffff") : "transparent"};
                    color: ${isTalkToMe ? (isDark ? "#000000" : "#ffffff") : isCustomer ? (isDark ? "#ffffff" : "#000000") : "transparent"};               
                    transition: opacity 0.2s;
                "
                aria-label="Play/Pause áudio"
                >
                    <i data-lucide="play" style="width: 18px; height: 18px; margin-left: 2px; fill: ${isTalkToMe ? (isDark ? "#000000" : "#ffffff") : (isCustomer ? (isDark ? "#ffffff" : "#000000") : "transparent")};"></i>
                </button>
                <div style="flex: 1; display: flex; flex-direction: column;">
                    <div style="
                    width: 100%;
                    height: 32px;
                    display: flex;
                    border-radius: 4px;
                    align-items: center;
                    justify-content: space-between;
                    gap: 2px;
                    top: 5px;
                    cursor: pointer;
                    position: relative;
                    " class="ttm-audio-waveform" data-progress="0">
                    ${Array.from({length: 50}, (_, i) => `
                        <div style="
                        flex: 1;
                        height: 20%;
                        background: ${isDark ? "#000000" : "#d1d5db"};
                        border-radius: 2px;
                        transition: all 0.3s ease;
                        " class="ttm-waveform-bar" data-bar-index="${i}"></div>
                    `).join('')}
                    </div>
                    <div style="
                    display: flex;
                    justify-content: end;
                    font-size: 11px;
                    color: ${textColor};
                    opacity: 0.7;
                    ">
                    <span class="ttm-audio-current-time">0:00</span>
                    <span class="ttm-audio-separator"> / </span>
                    <span class="ttm-audio-duration">0:00</span>
                    </div>
                </div>
                <audio class="ttm-audio-element" preload="metadata" style="display: none;">
                    <source src="${message.media.file}" type="${message.media.content_type}">
                </audio>
            </div>
        ` : ""}
        ${message.media && !message.media.content_type?.startsWith("image") && !message.media.content_type?.startsWith("video") && !message.media.content_type?.startsWith("audio") ? `
            <div
            class="ttm-file-download"
            style="
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 4px;
                border-radius: 8px;
                text-decoration: none;
                color: ${textColor};
                transition: all 0.2s;
                max-width: 280px;
            "
            >
            <div style="
                width: 40px;
                height: 40px;
                background: ${isDark ? '#1a1a1a' : '#e9e9e9'};
                border-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            ">
                <i data-lucide="file" style="width: 20px; height: 20px; color: ${isDark ? '#ffffff' : '#000000'};"></i>
            </div>
            <div 
                style="
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 2px;
                ">
                <span style="
                font-size: 14px;
                font-weight: 500;
                color: ${textColor};
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                ">
                ${message.media.file.split('/').pop().split('?')[0] || 'Arquivo'}
                </span>
                <span style="
                font-size: 12px;
                color: ${textColor};
                opacity: 0.7;
                ">
                ${message.media.content_type || 'Documento'}
                </span>
            </div>
            <a             
            href="${message.media.file}" 
            class="ttm-download-btn"
            data-file-url="${message.media.file}"
            data-file-name="${message.media.file.split('/').pop().split('?')[0]}"
            style="
                cursor: pointer;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                transition: all 0.2s;
            ">
                <i data-lucide="download" style="width: 18px; height: 18px; color: ${textColor}; opacity: 0.7;"></i>
            </a>
            </div>
        ` : ""}
            ${message.text ? `<p class="text-sm m-0 whitespace-normal break-words">${message.text}</p>` : ""}
            ${message.interactive && message.interactive.type === "button" ? `
                <div class="flex mt-2  flex-col gap-1">
                ${message.interactive.options.map(option => `
                <button class="w-full px-6 py-2 rounded-lg h-full cursor-pointer" 
                style="
                background: ${isDark ? "#ffffff" : "#181818"};
                border: none; 
                color: ${isDark ? "#000000" : "#ffffff"};
                "
                data-option-label="${option.label}" onmouseover="this.style.background='${isDark ? "#f0f0f0" : "#282828"}'"
                onmouseout="this.style.background='${isDark ? "#ffffff" : "#181818"}'"
                >
                    ${option.label} 
                </button>
                `).join("")}
                </div>
            ` : ""}
            </div>
        `;

        this.messagesContainer.appendChild(messageElement);
        this.lucide.createIcons();
        this._initAudioPlayers();


        if (message.media && !message.media.content_type?.startsWith("image") && !message.media.content_type?.startsWith("audio")) {
            const downloadBtn = messageElement.querySelector('.ttm-download-btn');
            if (downloadBtn) {
                downloadBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const fileUrl = downloadBtn.dataset.fileUrl;
                    const fileName = downloadBtn.dataset.fileName;

                    try {
                        const response = await fetch(fileUrl);
                        const blob = await response.blob();
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.style.display = 'none';
                        a.href = url;
                        a.download = fileName;
                        document.body.appendChild(a);
                        a.click();
                        window.URL.revokeObjectURL(url);
                        document.body.removeChild(a);
                    } catch (error) {
                    }
                });
            }
        }

            if (message.interactive?.options) {
                const buttons = messageElement.querySelectorAll('button[data-option-label]');
                buttons.forEach(button => {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    this._sendMessage(button.dataset.optionLabel);
                });
                });
            }

            if (this.messagesContainer && !this.userIsScrolling) {
                requestAnimationFrame(() => {
                this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
                });
            }
        }
    }
  
    window.TalkToMeChat = TalkToMeChat;
  })(window);

