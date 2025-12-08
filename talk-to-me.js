(function (window) {
  "use strict";

  class TalkToMeChat {
    constructor(config) {
      if (!config.token) {
        throw new Error('TalkToMe: token é obrigatório. new TalkToMeChat({ token: "..." })');
      }

      // Configurações
      this.token = config.token;
      this.wsUrl = config.wsUrl;
      this.config = {};
      
      // Estado da Sessão e Usuário
      this.sessionId = this._generateId('session_');
      this.userIdentifier = this._getOrSetLocalStorage("ttm_user_id", () => Math.random().toString(36).substring(2, 15));
      this.userName = localStorage.getItem("ttm_user_name");
      this.threadId = localStorage.getItem("ttm_thread_id");
      
      // Estado da Conexão e Chat
      this.ws = null;
      this.isOpen = false;
      this.channelInactive = false;
      this.librariesLoaded = false;
      
      // Filas e Controle de Mensagens
      this.displayedMessages = new Set();
      this.messagesQueue = [];
      this.pendingWebSocketMessages = [];
      this.messagesLoaded = false;
      this.isProcessingQueue = false;
      this._unreadCount = 0;
      this._waitingForHistory = false;

      // UI Elementos
      this.ui = {}; // Armazena referências do DOM (container, chatWindow, input, etc)
      
      // Bibliotecas Externas
      this.libs = { Motion: null, lucide: null };
      
      // Inicialização de Tema Padrão
      this.theme = {
        theme: "dark",
        name: "Chat",
        bodyColor: "#151619",
        icon: "message-circle",
        logo_url: null,
        wallpaper_url: null,
      };
    }

    // =========================================================================
    // Helpers & Utils
    // =========================================================================

    get isDark() {
      return this.theme.theme === "dark";
    }

    _generateId(prefix = '') {
      return prefix + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    }

    _getOrSetLocalStorage(key, generatorFn) {
      let value = localStorage.getItem(key);
      if (!value) {
        value = generatorFn();
        localStorage.setItem(key, value);
      }
      return value;
    }

    async _loadScript(src, globalCheck, configCallback) {
      if (window[globalCheck]) {
        if (configCallback) configCallback(window[globalCheck]);
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => {
          if (configCallback) configCallback(window[globalCheck]);
          resolve();
        };
        script.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
        document.head.appendChild(script);
      });
    }

    // =========================================================================
    // Inicialização
    // =========================================================================

    async init() {
      await this._loadLibraries();
      this._createUI();
      if (this.ui.container) this.ui.container.style.display = 'none';
      this._connectWebSocket();
    }

    async _loadLibraries() {
      if (this.librariesLoaded) return;

      try {
        await Promise.all([
          this._loadScript("https://cdn.tailwindcss.com", "tailwind", (tw) => {
             if(tw) tw.config = { corePlugins: { preflight: false } };
          }),
          this._loadScript("https://cdn.jsdelivr.net/npm/framer-motion@11/dist/framer-motion.js", "Motion", (m) => this.libs.Motion = m),
          this._loadScript("https://unpkg.com/lucide@latest", "lucide", (l) => this.libs.lucide = l)
        ]);
        this.librariesLoaded = true;
      } catch (e) {
        console.error("TTM: Erro ao carregar bibliotecas", e);
      }
    }

    // =========================================================================
    // WebSocket & Rede
    // =========================================================================

    _connectWebSocket() {
      const url = `${this.wsUrl}/ws/session:${this.sessionId}/${this.threadId || 'new'}?token=${this.token}`;
      this.ws = new WebSocket(url);

      const connectionTimeout = setTimeout(() => {
        if (this.ws?.readyState === WebSocket.CONNECTING) {
          console.error('TTM: Timeout na conexão WebSocket');
          this._closeWebSocket();
          this.channelInactive = true;
        }
      }, 5000);

      this.ws.onopen = () => {
        clearTimeout(connectionTimeout);
        this.channelInactive = false;
        if (this.ui.container) this.ui.container.style.display = 'block';
        this._requestMetadata();
        if (!this.messagesLoaded) this._loadMessages();
      };

      this.ws.onerror = () => {
        clearTimeout(connectionTimeout);
        if (this.ui.container) this.ui.container.style.display = 'none';
      };

      this.ws.onclose = (e) => {
        clearTimeout(connectionTimeout);
        console.log('TTM: WebSocket fechado', e.code);
        this.ws = null;
        if (this.ui.container) this.ui.container.style.display = 'none';
      };

      this.ws.onmessage = (event) => this._handleWebSocketMessage(JSON.parse(event.data));
    }

    _handleWebSocketMessage(data) {
      // Atualiza threadId se vier do servidor
      if (data.external_id || (data.data && data.data.external_id)) {
        this.threadId = data.external_id || data.data.external_id;
        localStorage.setItem("ttm_thread_id", this.threadId);
      }

      switch (data.type) {
        case "metadata":
          if (data.data) this._handleMetadata(data.data);
          break;
        case "history":
          if (data.data?.messages) {
            data.data.messages.forEach(m => this.pendingWebSocketMessages.push(m));
          }
          this._waitingForHistory = false;
          break;
        case "message":
          this._handleIncomingMessage(data.data);
          break;
        case "presence":
          if (data.data?.status === "typing") this._displayPresence();
          break;
        case "error":
          this._closeWebSocket();
          break;
        case "finish":
          this._clearThreadData();
          this._closeWebSocket();
          setTimeout(() => { alert("TENTANDO RECONEXÃO..."); this._connectWebSocket(); }, 100);
          break;
      }
    }

    _handleIncomingMessage(message) {
      if (this.messagesLoaded) {
        this._enqueueMessage(message, true);
        if (!this.isOpen && message.origin !== "customer") {
          this._unreadCount++;
          this._updateNotificationCounter();
        }
      } else {
        this.pendingWebSocketMessages.push(message);
      }
      this._clearPresence();
    }

    _sendMessage(textOverride = null, files = null) {
      const text = textOverride || this.ui.inputField.value;
      if (!text && !files) return;
      if (this.channelInactive) return;

      if (!textOverride && this.ui.inputField) {
        this.ui.inputField.value = "";
        this.ui.inputField.style.height = "auto";
      }

      // Display local message immediately (optimistic UI)
      if (text) {
        this._enqueueMessage({
          text,
          origin: "customer",
          created_at: new Date().toISOString(),
          timestamp: Date.now(),
        });
      }

      // Reconnect if needed
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
         this._connectWebSocket();
         // Nota: Num cenário real, idealmente espera a conexão abrir antes de enviar
      }

      if(this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'send_message',
            data: {
              token: this.token,
              name: this.userName,
              user_id: this.userIdentifier,
              text: text || null,
              metadata: { origin: window.location.host },
              thread_id: this.threadId
            }
          }));
      }
    }

    _closeWebSocket() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
      this.ws = null;
      if (this.ui.container) this.ui.container.style.display = 'none';
    }

    // =========================================================================
    // Gerenciamento de Dados e Estado
    // =========================================================================

    _requestMetadata() {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "metadata", data: { token: this.token } }));
      }
    }

    _handleMetadata(data) {
      this.config = { name: data.name, ...data, widget_style: data.widget_style };
      if (this.config.widget_style) this._applyWidgetStyles(this.config.widget_style);
    }

    _clearThreadData() {
      ["ttm_thread_id", "ttm_user_id", "ttm_user_name"].forEach(k => localStorage.removeItem(k));
      this.threadId = null;
      this.userName = null;
      this.messagesLoaded = false;
      this.displayedMessages.clear();
      this.messagesQueue = [];
      this.pendingWebSocketMessages = [];
      this.userIdentifier = this._generateId();
      this._updateNotificationCounter();
      if (this.ui.messagesContainer) this.ui.messagesContainer.innerHTML = "";
    }

    async _loadMessages() {
      if (this.messagesLoaded) return;
      
      if (this.threadId && this.ws?.readyState === WebSocket.OPEN) {
        this._waitingForHistory = true;
        this.ws.send(JSON.stringify({ type: 'history', data: { thread_id: this.threadId, token: this.token } }));
        
        // Wait w/ timeout
        const maxWait = 3000;
        const start = Date.now();
        while (this._waitingForHistory && (Date.now() - start) < maxWait) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
      
      this.messagesLoaded = true;
      // Processa mensagens que chegaram enquanto carregava o histórico
      if (this.pendingWebSocketMessages.length > 0) {
        this.pendingWebSocketMessages.forEach(m => this._enqueueMessage(m));
        this.pendingWebSocketMessages = [];
      }
    }

    // =========================================================================
    // UI - Construção e Tema
    // =========================================================================

    _applyWidgetStyles(style) {
      Object.assign(this.theme, style);
      this._updateUITheme();
    }

    _updateUITheme() {
        if (!this.ui.chatWindow) return;
        
        const isDark = this.isDark;
        const colors = this._getThemeColors();

        // Atualizações pontuais de elementos
        if (this.theme.buttonColor) this.ui.chatWindow.style.background = this.theme.buttonColor;
        
        const header = this.ui.chatContent?.querySelector('.ttm-header');
        if (header) {
            header.style.background = this.theme.headerColor;
            header.style.borderBottom = `1px solid ${colors.border}`;
        }
        
        // Renderização de Logos/Avatares no Header
        this._renderHeaderAvatars(header, isDark);
        
        // Background Wallpaper
        const messageAreas = this.ui.chatContent?.querySelectorAll('.ttm-msg-area');
        messageAreas.forEach(area => {
            if (this.theme.wallpaper_url) {
                area.style.backgroundImage = `url(${this.theme.wallpaper_url})`;
                area.style.backgroundSize = 'cover';
            } else {
                area.style.background = this.theme.bodyColor;
            }
        });

        // Input Area
        if(this.ui.inputContainer) this.ui.inputContainer.style.background = colors.inputBg;
        if(this.ui.inputField) {
            this.ui.inputField.style.color = colors.text;
            this._updatePlaceholderColor(colors.placeholder);
        }
        
        // Botões
        if(this.ui.sendButton) {
            this.ui.sendButton.style.background = colors.inverseBg;
            const icon = this.ui.sendButton.querySelector('svg');
            if(icon) {
                icon.style.stroke = colors.inverseText;
                icon.style.color = colors.inverseText;
            }
        }

        // Link Container
        this._renderLinkContainer(colors);

        if (this.libs.lucide) this.libs.lucide.createIcons();
    }

    _getThemeColors() {
        const d = this.isDark;
        return {
            bg: d ? "#151619" : "#ffffff",
            text: d ? "#ffffff" : "#000000",
            inverseBg: d ? "#ffffff" : "#000000",
            inverseText: d ? "#000000" : "#ffffff",
            border: d ? "#565656" : "#d1d5db",
            inputBg: d ? "#212224" : "#e9e9e9",
            placeholder: d ? "#e5e7eb" : "#0D0D0D",
            avatarBg: d ? '#494949' : '#d4d4d4'
        };
    }

    _renderHeaderAvatars(header, isDark) {
        if (!header) return;
        
        // Limpa anteriores
        const titleEl = header.querySelector('h3');
        const existing = header.querySelector('.ttm-avatars');
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.className = 'ttm-avatars flex ml-[10px] items-center mt-1';
        
        const logos = (Array.isArray(this.theme.logos_url) ? this.theme.logos_url : []).filter(Boolean);
        
        if (logos.length > 0) {
            logos.forEach((logo, idx) => {
                const div = document.createElement('div');
                div.className = 'w-[2.5rem] h-[2.5rem] rounded-full border-2 flex items-center justify-center flex-shrink-0';
                div.style.background = this._getThemeColors().avatarBg;
                if (idx > 0) div.style.marginLeft = '-14px';
                
                const img = document.createElement('img');
                img.src = logo;
                img.className = 'w-full h-full rounded-full object-cover';
                div.appendChild(img);
                container.appendChild(div);
            });
        } else {
            // Avatar padrão
            container.innerHTML = `
                <div class="w-[2.5rem] h-[2.5rem] rounded-full border-2 flex items-center justify-center flex-shrink-0" style="background: ${this._getThemeColors().avatarBg}">
                   <i data-lucide="user" class="size-5" style="color: ${isDark?'white':'black'}"></i>
                </div>`;
        }
        
        if (titleEl) header.insertBefore(container, titleEl);
        else header.appendChild(container);
    }

    _renderLinkContainer(colors) {
        const parent = this.ui.inputContainer?.parentElement;
        if (!parent) return;
        
        parent.querySelector('.ttm-link-container')?.remove();

        if (this.theme.link && this.theme.link_label) {
            const div = document.createElement('div');
            div.className = 'ttm-link-container flex items-center justify-center rounded-lg mt-2 px-2 py-1 mx-auto w-fit gap-2';
            div.style.background = colors.inputBg;
            div.innerHTML = `
                <i data-lucide="link" style="width: 16px; height: 16px; color: ${colors.text};"></i>
                <a href="${this.theme.link}" target="_blank" class="text-sm no-underline" style="color: ${colors.text};">${this.theme.link_label}</a>
            `;
            parent.appendChild(div);
        }
    }

    _injectCustomStyles() {
        const isDark = this.isDark;
        // Styles simplificados para brevidade, mantendo os originais
        const css = `
            #ttm-chat-container * { box-sizing: border-box; }
            .ttm-message-customer { justify-content: flex-end !important; }
            .ttm-message { animation: ttm-slide-in 0.3s ease-in-out; }
            #ttm-input::placeholder { color: ${isDark ? "#e5e7eb" : "#0D0D0D"} !important; }
            @keyframes ttm-slide-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
 
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

        

            #ttm-input {
            box-sizing: border-box !important;
            overflow-y: auto !important;
            font-family: inherit !important;
            }
    
            #ttm-input::placeholder {
            color: ${isDark ? "#e5e7eb" : "#0D0D0D"} !important;
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

            .ttm-agent-typing {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            }

            .ttm-agent-typing-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: ${isDark ? "#ffffff" : "#000000"};
            animation: ttm-typing-dot 1.4s infinite ease-in-out;
            }

            .ttm-agent-typing-dot:nth-child(1) {
                animation-delay: 0s;
            }

            .ttm-agent-typing-dot:nth-child(2) {
                animation-delay: 0.2s;
            }

            .ttm-agent-typing-dot:nth-child(3) {
                animation-delay: 0.4s;
            }

            @keyframes ttm-typing-dot {
                0%, 60%, 100% {
                    opacity: 0.3;
                    transform: scale(0.8);
                }
                30% {
                    opacity: 1;
                    transform: scale(1);
                }
            }


            @keyframes ttm-pulse {
    
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
        let style = document.querySelector('style[data-ttm-styles]');
        if (!style) {
            style = document.createElement("style");
            style.setAttribute('data-ttm-styles', 'true');
            document.head.appendChild(style);
        }
        style.textContent = css;
    }
    
    _updatePlaceholderColor(color) {
        const style = document.querySelector('style[data-ttm-styles]');
        if(style) {
             style.textContent = style.textContent.replace(
                /(#ttm-input::placeholder\s*\{[^}]*color:\s*)[^;]+(;)/,
                `$1${color}$2`
            );
        }
    }

    _createUI() {
      this._injectCustomStyles();
      this.ui.container = document.createElement("div");
      this.ui.container.id = "ttm-chat-container";
      this._createVisualizerOverlay();
      
      const colors = this._getThemeColors();

      // Template HTML Principal
      this.ui.container.innerHTML = `
          <div id="ttm-chat-window" class="fixed flex flex-col border-2 shadow-2xl cursor-pointer"
              style="background: ${this.theme.buttonColor}; bottom: 20px; right: 20px; border-radius: 24px; z-index: 9999; border: none; width: 46px; height: 46px;">
              
              <div id="ttm-button-icon" class="absolute inset-0 flex items-center justify-center">
                  <i data-lucide="${this.theme.icon}" class="size-5" style="color: ${colors.text}"></i>
              </div>
              
              <div class="ttm-notification-counter absolute hidden flex items-center justify-center bg-red-500 rounded-full border-2 border-white px-1.5 h-5" style="top: -4px; right: 4px; z-index: 10000; transform: translate(6px, -6px);">
                  <span class="text-[11px] text-white font-semibold leading-none">0</span>
              </div>

              <div id="ttm-chat-content" class="flex flex-col h-full" style="opacity: 0; pointer-events: none; display: none;">
                  <div class="ttm-header p-1 flex items-start gap-2 flex-shrink-0" style="background: ${this.theme.headerColor}; border-bottom: 1px solid ${colors.border};">
                      <h3 class="flex-1 text-base font-normal mt-[0.9rem] ml-1" style="color: ${colors.text}">${this.theme.name}</h3>
                      <button id="ttm-close-button" class="w-9 h-9 bg-transparent flex items-center justify-center self-end m-1.5 border-none cursor-pointer hover:opacity-90">
                          <i data-lucide="x" style="width: 16px; color: ${colors.text}"></i>
                      </button>
                  </div>

                  ${this.userName === null ? `
                  <div id="ttm-first-step-container" class="flex-1 flex overflow-y-auto flex-col items-center justify-center">
                      <input type="text" id="ttm-first-step-input" class="w-[80%] h-12 border-none text-center rounded-lg mt-3" placeholder="Qual é o seu nome?" 
                             style="color: ${colors.text}; background: ${colors.inputBg}">
                      <button type="button" id="ttm-first-step-button" class="mt-2 rounded-lg px-4 py-1 border-none cursor-pointer" 
                              style="background: ${colors.inverseBg}; color: ${colors.inverseText}">Ok</button>
                  </div>` : ''}

                  <div id="ttm-messages-wrapper" class="flex-1 flex overflow-y-auto flex-col" style="display: ${this.userName ? 'flex' : 'none'}">
                      <div id="ttm-messages" class="ttm-msg-area flex-1 p-2 flex flex-col gap-2 bg-transparent overflow-y-scroll"></div>
                      
                      <div class="p-2 flex-shrink-0">
                          <div id="ttm-input-container" class="flex flex-col p-1 gap-0 rounded-[1.5rem]" style="background: ${colors.inputBg}">
                              <textarea id="ttm-input" class="flex p-1 w-full border-none bg-transparent resize-none outline-none text-sm max-h-[100px]" 
                                        style="color: ${colors.text}; padding-left: 1rem; padding-top:10px" placeholder="Digite aqui..."></textarea>
                              <div class="flex justify-between w-full gap-2">
                                  <div class="flex-1"></div> <button id="ttm-send-button" class="w-8 h-8 rounded-full flex items-center justify-center m-1.5 border-none cursor-pointer"
                                          style="background: ${colors.inverseBg}">
                                      <i data-lucide="arrow-up" style="width: 16px; color: ${colors.inverseText}"></i>
                                  </button>
                              </div>
                          </div>
                      </div>
                  </div>
              </div>
          </div>
      `;

      document.body.appendChild(this.ui.container);
      this._bindUIEvents();
      if (this.libs.lucide) this.libs.lucide.createIcons();
    }

    _bindUIEvents() {
        // Mapeia elementos para this.ui para acesso rápido
        const ids = ['chat-window', 'button-icon', 'input', 'chat-content', 'send-button', 'messages', 'close-button', 'input-container'];
        ids.forEach(id => this.ui[id.replace(/-([a-z])/g, g => g[1].toUpperCase())] = document.getElementById(`ttm-${id}`)); // ex: ttm-chat-window -> ui.chatWindow
        this.ui.messagesContainer = document.getElementById('ttm-messages'); // alias

        this.ui.chatWindow.addEventListener("click", () => !this.isOpen && this._openChat());
        this.ui.closeButton.addEventListener("click", (e) => { e.stopPropagation(); this._closeChat(); });
        
        this.ui.sendButton?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this._sendMessage(); });
        
        this.ui.input?.addEventListener("keypress", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._sendMessage(); }
        });
        
        this.ui.input?.addEventListener("input", (e) => {
            e.target.style.height = "30px";
            e.target.style.height = Math.min(e.target.scrollHeight, 100) + "px";
        });

        // Lógica do Primeiro Passo (Nome)
        const btnStep = document.getElementById("ttm-first-step-button");
        const inpStep = document.getElementById("ttm-first-step-input");
        if(btnStep) {
            btnStep.addEventListener("click", (e) => {
                e.preventDefault(); e.stopPropagation();
                const name = inpStep.value.trim();
                if(name) {
                    this.userName = name;
                    localStorage.setItem("ttm_user_name", name);
                    document.getElementById("ttm-first-step-container").style.display = 'none';
                    document.getElementById("ttm-messages-wrapper").style.display = 'flex';
                }
            });
            inpStep.addEventListener("keypress", (e) => { if(e.key === "Enter") btnStep.click(); });
        }
    }

    _openChat() {
      this.isOpen = true;
      this.ui.chatWindow.classList.add('overflow-hidden');
      this.ui.chatWindow.setAttribute("data-open", "true");
      this.ui.chatWindow.style.cursor = "default";
      this.ui.buttonIcon.style.opacity = "0";
      this.ui.buttonIcon.style.display = "none";
      this.ui.chatContent.style.display = "flex";
      this.ui.chatWindow.style.transition = "all 0.35s ease";
      
      // Estilos de tamanho expandido
      this.ui.chatWindow.style.width = "343px";
      this.ui.chatWindow.style.height = "550px";
      this.ui.chatWindow.style.borderRadius = "14px";
      this.ui.chatContent.style.opacity = "1";
      this.ui.chatContent.style.pointerEvents = "auto";
      
      this._resetNotificationCounter();
      if (!this.ws && !this.channelInactive) this._connectWebSocket();
    }

    _closeChat() {
      this.isOpen = false;
      this.ui.chatWindow.setAttribute("data-open", "false");
      this.ui.chatWindow.style.cursor = "pointer";
      this.ui.chatContent.style.opacity = "0";
      this.ui.chatContent.style.pointerEvents = "none";
      this.ui.chatContent.style.display = "none";
      this.ui.buttonIcon.style.display = "flex";
      this.ui.buttonIcon.style.opacity = "1";
      this.ui.chatWindow.style.width = "44px";
      this.ui.chatWindow.style.height = "44px";
      this.ui.chatWindow.style.borderRadius = "24px";
      this.ui.chatWindow.classList.remove('overflow-hidden');
      this.libs.lucide?.createIcons();
    }

    // =========================================================================
    // Renderização de Mensagens (Refatorado)
    // =========================================================================

    async _processMessageQueue() {
      if (this.isProcessingQueue || this.messagesQueue.length === 0) return;
      this.isProcessingQueue = true;
      
      while (this.messagesQueue.length > 0) {
        const msg = this.messagesQueue.shift();
        this._displayMessage(msg);
        if (msg.isNewMessage) await new Promise(r => setTimeout(r, 500));
      }
      this.isProcessingQueue = false;
    }

    _enqueueMessage(message, isNewMessage = false) {
      const key = `${message.text || ''}_${message.origin}_${message.created_at || message.timestamp}`;
      if (this.displayedMessages.has(key)) return;
      
      this.displayedMessages.add(key);
      message.isNewMessage = isNewMessage;
      this.messagesQueue.push(message);
      this._processMessageQueue();
    }

    _displayMessage(message) {
      const isDark = this.isDark;
      const isCustomer = message.origin === "customer";
      const isAgent = !isCustomer;

      // Definição de Cores da Bolha
      let bubbleBg, textColor;
      if (isAgent) {
          bubbleBg = isDark ? "#000000" : "#ebeaea";
          textColor = isDark ? "#ffffff" : "#000000";
      } else {
          bubbleBg = isDark ? "#ffffff" : "#000000";
          textColor = isDark ? "#000000" : "#ffffff";
      }

      const div = document.createElement("div");
      div.className = `ttm-message ${isCustomer ? "ttm-message-customer" : "ttm-message-agent"}`;
      
      // Conteúdo Interno
      let contentHtml = '';
      if(message.media) {
          const type = message.media.content_type || '';
          if(type.startsWith("image")) contentHtml += this._renderImage(message.media);
          else if(type.startsWith("video")) contentHtml += this._renderVideo(message.media);
          else if(type.startsWith("audio")) contentHtml += this._renderAudio(message.media, isCustomer, isDark);
          else contentHtml += this._renderFile(message.media, textColor, isDark);
      }
      
      if (message.text) contentHtml += `<p class="text-sm m-0 whitespace-normal break-words">${message.text}</p>`;
      
      if (message.interactive?.type === "button") {
          contentHtml += this._renderButtons(message.interactive.options, isDark);
      }

      div.innerHTML = `
          <div class="relative w-fit max-w-[80%] h-full rounded-xl px-2 py-2 break-words"
               style="background: ${bubbleBg}; color: ${textColor}; border: 1px solid ${isDark && isCustomer ? '#d1d5db' : (isAgent && !isDark ? '#d1d5db' : 'transparent')}">
             ${contentHtml}
          </div>
          ${isAgent && message.metadata?.ai_agent?.name ? `<span class="text-xs mt-1 block" style="opacity: 0.7; color: ${isDark?'#fff':'#000'}">${message.metadata.ai_agent.name}</span>` : ""}
      `;

      this.ui.messagesContainer.appendChild(div);
      this.libs.lucide?.createIcons();
      this._attachMessageListeners(div);
      
      // Auto scroll
      requestAnimationFrame(() => this.ui.messagesContainer.scrollTop = this.ui.messagesContainer.scrollHeight);
    }

    // Helpers de Renderização de Mídia
    _renderImage(media) {
        return `<img src="${media.file}" class="w-full max-w-[280px] h-auto ttm-media-visualizer cursor-pointer rounded-md object-cover" data-media-src="${media.file}" data-media-type="image"/>`;
    }
    
    _renderVideo(media) {
        return `<video src="${media.file}" class="w-full max-w-[280px] h-auto ttm-media-visualizer cursor-pointer rounded-md object-cover" data-media-src="${media.file}" data-media-type="video" controls></video>`;
    }

    _renderFile(media, textColor, isDark) {
        const fileName = media.file.split('/').pop().split('?')[0] || 'Arquivo';
        const iconBg = isDark ? '#1a1a1a' : '#e9e9e9';
        const iconColor = isDark ? '#ffffff' : '#000000';
        
        return `
         <div class="flex items-center gap-3 p-1 rounded-lg max-w-[280px]">
            <div style="background: ${iconBg}" class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0">
                <i data-lucide="file" style="width: 20px; color: ${iconColor}"></i>
            </div>
            <div class="flex-1 min-w-0 flex flex-col">
                <span class="text-sm font-medium truncate">${fileName}</span>
                <span class="text-xs opacity-70">${media.content_type || 'Documento'}</span>
            </div>
            <a href="${media.file}" class="ttm-download-btn w-8 h-8 flex items-center justify-center" download>
                <i data-lucide="download" style="width: 18px; color: ${textColor}"></i>
            </a>
         </div>`;
    }

    _renderButtons(options, isDark) {
        const bg = isDark ? "#ffffff" : "#181818";
        const color = isDark ? "#000000" : "#ffffff";
        return `<div class="flex mt-2 flex-col gap-1">
            ${options.map(opt => `
                <button class="w-full px-6 py-2 rounded-lg cursor-pointer border-none" 
                        style="background: ${bg}; color: ${color}" data-option-label="${opt.label}">
                    ${opt.label}
                </button>
            `).join("")}
        </div>`;
    }
    
    _renderAudio(media, isCustomer, isDark) {
        // Gera apenas o HTML, a lógica vai no _attachMessageListeners
        const playBg = isCustomer ? (isDark ? '#1a1a1a' : '#ffffff') : (isDark ? '#ffffff' : '#000000');
        const playColor = isCustomer ? (isDark ? '#ffffff' : '#000000') : (isDark ? '#000000' : '#ffffff');
        const barColor = isDark ? "#000000" : "#d1d5db";
        
        return `
        <div class="ttm-audio-player flex items-center gap-2" style="width: 220px;">
            <button class="ttm-audio-play-btn w-8 h-8 rounded-full flex items-center justify-center border-none cursor-pointer" 
                    style="background: ${playBg}; color: ${playColor}">
                 <i data-lucide="play" class="size-4 ml-[2px]"></i>
            </button>
            <div class="flex-1 flex flex-col gap-1">
                <div class="ttm-audio-waveform h-8 flex items-center justify-between gap-[2px] cursor-pointer">
                    ${Array.from({length: 30}).map((_, i) => `<div class="ttm-waveform-bar flex-1 h-[20%] rounded-[2px] transition-all" style="background: ${barColor}" data-index="${i}"></div>`).join('')}
                </div>
                <div class="flex justify-end text-[10px] opacity-70 font-mono">
                    <span class="current">0:00</span> / <span class="duration">0:00</span>
                </div>
            </div>
            <audio src="${media.file}" class="ttm-audio-element hidden" preload="metadata"></audio>
        </div>`;
    }

    _attachMessageListeners(element) {
        // Buttons
        element.querySelectorAll('button[data-option-label]').forEach(btn => {
            btn.addEventListener('click', (e) => { e.preventDefault(); this._sendMessage(btn.dataset.optionLabel); });
        });

        // Audio
        const audioPlayer = element.querySelector('.ttm-audio-player');
        if (audioPlayer) this._initSingleAudioPlayer(audioPlayer);
    }
    
    // =========================================================================
    // Lógica de Áudio e Visualizer
    // =========================================================================

    async _initSingleAudioPlayer(container) {
        if(container.dataset.ready) return;
        container.dataset.ready = "true";
        
        const audio = container.querySelector('audio');
        const btn = container.querySelector('.ttm-audio-play-btn');
        const waveform = container.querySelector('.ttm-audio-waveform');
        const bars = waveform.querySelectorAll('.ttm-waveform-bar');
        const timeDisplay = container.querySelector('.current');
        const durationDisplay = container.querySelector('.duration');
        const icon = btn.querySelector('i');
        
        // Simulação de Waveform (para não travar UI com fetch de arraybuffer em cada msg)
        // Se quiser a lógica real de fetch, pode reinserir _generateWaveformData aqui
        bars.forEach(bar => bar.style.height = `${Math.floor(Math.random() * 60 + 20)}%`);

        const formatTime = s => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
        
        audio.addEventListener('loadedmetadata', () => durationDisplay.textContent = formatTime(audio.duration));
        
        audio.addEventListener('timeupdate', () => {
            timeDisplay.textContent = formatTime(audio.currentTime);
            const percent = (audio.currentTime / audio.duration);
            const filled = Math.ceil(percent * bars.length);
            // Cor ativa depende do tema, simplificando aqui para 'cinza escuro' vs 'original'
            bars.forEach((b, i) => b.style.opacity = i < filled ? '1' : '0.4'); 
        });

        audio.addEventListener('ended', () => {
            icon.setAttribute('data-lucide', 'play');
            this.libs.lucide?.createIcons();
            bars.forEach(b => b.style.opacity = '0.4');
        });

        btn.addEventListener('click', (e) => {
             e.stopPropagation();
             if (audio.paused) {
                 // Pausa todos os outros
                 document.querySelectorAll('audio').forEach(a => { if(a !== audio) { a.pause(); a.currentTime=0; } }); 
                 document.querySelectorAll('.ttm-audio-play-btn i').forEach(i => i.setAttribute('data-lucide', 'play'));
                 
                 audio.play();
                 icon.setAttribute('data-lucide', 'pause');
             } else {
                 audio.pause();
                 icon.setAttribute('data-lucide', 'play');
             }
             this.libs.lucide?.createIcons();
        });
        
        waveform.addEventListener('click', (e) => {
            const rect = waveform.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            if(audio.duration) audio.currentTime = pct * audio.duration;
        });
    }

    _createVisualizerOverlay() {
        const div = document.createElement('div');
        div.id = 'ttm-visualizer';
        div.style.display = 'none';
        div.className = 'fixed inset-0 z-[99999] bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm';
        div.innerHTML = `
            <button class="absolute top-4 right-4 text-white"><i data-lucide="x" class="size-8"></i></button>
            <div id="ttm-visualizer-content" class="max-w-full max-h-full"></div>
        `;
        document.body.appendChild(div);
        
        const close = () => div.style.display = 'none';
        div.querySelector('button').onclick = close;
        div.onclick = (e) => { if(e.target === div) close(); };

        // Delegate click for media
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('ttm-media-visualizer') && e.target.tagName !== 'VIDEO') {
                const src = e.target.dataset.mediaSrc;
                if(src) {
                    const content = div.querySelector('#ttm-visualizer-content');
                    content.innerHTML = `<img src="${src}" class="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl">`;
                    div.style.display = 'flex';
                    this.libs.lucide?.createIcons();
                }
            }
        });
    }

    // =========================================================================
    // Notificações e Presença
    // =========================================================================

    _updateNotificationCounter() {
        const el = this.ui.container?.querySelector('.ttm-notification-counter');
        if(!el) return;
        if (this._unreadCount > 0) {
            el.querySelector('span').textContent = this._unreadCount;
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    }

    _resetNotificationCounter() {
        this._unreadCount = 0;
        this._updateNotificationCounter();
    }

    _displayPresence() {
        this._clearPresence();
        const div = document.createElement("div");
        div.className = "ttm-presence ml-2 mb-2";
        const bg = this.isDark ? "#000000" : "#ebeaea";
        
        div.innerHTML = `
           <div class="px-3 py-2 rounded-xl w-fit" style="background: ${bg}">
              <div class="ttm-agent-typing flex gap-1">
                  <div class="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"></div>
                  <div class="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style="animation-delay: 0.1s"></div>
                  <div class="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style="animation-delay: 0.2s"></div>
             </div>
            </div>`;
        this.ui.messagesContainer.appendChild(div);
        this.ui.messagesContainer.scrollTop = this.ui.messagesContainer.scrollHeight;
    }

    _clearPresence() {
        this.ui.messagesContainer?.querySelector('.ttm-presence')?.remove();
    }
  }

  window.TalkToMeChat = TalkToMeChat;
})(window);