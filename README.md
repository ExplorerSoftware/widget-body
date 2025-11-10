# TalkToMeChat Widget

Widget de chat em tempo real usando WebSocket.

## 📦 Instalação

### Via CDN

```html
<script src="https://cdn.jsdelivr.net/gh/ExplorerSoftware/widget-body@main/talk-to-me-chat.min.js"></script>
```

## 🚀 Uso Básico

```html
<!DOCTYPE html>
<html>
<head>
    <title>Meu Site</title>
</head>
<body>
    <h1>Meu Site</h1>
    
    <!-- Carregar o SDK -->
    <script src="https://cdn.jsdelivr.net/gh/ExplorerSoftware/widget-body@main/talk-to-me-chat.min.js"></script>
    
    <!-- Inicializar o chat -->
    <script>
      new TalkToMeChat({
        token: "seu-token-aqui"
      }).init();
    </script>
</body>
</html>
```

## ⚙️ Configuração

### Parâmetros

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|-----------|------|-------------|--------|-----------|
| `token` | `string` | ✅ Sim | - | Token de autenticação do canal |
| `wsUrl` | `string` | ❌ Não | `wss://talk-to-me.fly.dev` | URL do servidor WebSocket |

### Exemplo com URL customizada

```javascript
new TalkToMeChat({
  token: "bef238598a9fcd45e12f42331e30609c",
  wsUrl: "wss://seu-servidor.com"
}).init();
```

## 🔌 Comunicação via WebSocket

O widget usa **apenas WebSocket** para toda a comunicação:

- ✅ Configurações do chat (tema, cores, logo)
- ✅ Envio e recebimento de mensagens
- ✅ Upload de arquivos (via base64)
- ✅ Histórico de mensagens
- ✅ Notificações em tempo real

### Protocolo WebSocket

#### Buscar Configuração
```
Endpoint: wss://seu-servidor/config?token=<TOKEN>
Response: { theme, color, logo_url, name, icon, wallpaper_url }
```

#### Conexão do Chat
```
Endpoint: wss://seu-servidor/ws/<THREAD_ID>?token=<TOKEN>
Messages:
  - Receber: { type: "message", data: {...} }
  - Receber: { type: "thread_created", thread_id: "..." }
  - Receber: { type: "messages_history", messages: [...] }
  - Enviar: { type: "send_message", text, files, user_id, thread_id }
  - Enviar: { type: "get_messages", thread_id }
```

## 📁 Estrutura do Projeto

```
widget-body/
├── talk-to-me.js              # Código fonte
├── talk-to-me-chat.min.js     # Versão minificada (produção)
├── build.js                   # Script de build
├── example.html               # Exemplo de uso
├── package.json               # Dependências
└── README.md                  # Documentação
```

## 🛠️ Desenvolvimento

### Instalar dependências

```bash
npm install
```

### Build

```bash
node build.js
```

O script irá:
1. Ler o arquivo `talk-to-me.js`
2. Minificar usando Terser
3. Gerar `talk-to-me-chat.min.js`

## 📝 Changelog

### v1.0.0 (2025)
- ✨ Implementação completa via WebSocket
- 🗑️ Removida dependência de API HTTP
- 📦 Upload de arquivos via base64
- 🎨 Configuração via metadata do canal
- 💬 Chat em tempo real
- 🔔 Notificações de mensagens não lidas
- 🎙️ Gravação de áudio
- 📎 Suporte a múltiplos tipos de arquivo
- 🌓 Modo claro e escuro
- 📱 Responsivo

## 📄 Licença

© 2025 - TalkToMeChat SDK
