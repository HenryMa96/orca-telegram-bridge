// Texts the bridge sends to Telegram, in the language chosen by the `replyLanguage` setting.
// Log entries and the panel stay English; only what the Telegram user reads is translated.

export type ReplyLanguage = 'en' | 'pt-BR' | 'zh-CN'

export const REPLY_LANGUAGES: ReplyLanguage[] = ['en', 'pt-BR', 'zh-CN']

// Telegram slash command menu, in menu order.
export const TELEGRAM_COMMAND_NAMES = [
  'help',
  'new',
  'home',
  'bots',
  'use',
  'chats',
  'bind',
  'rename',
  'sync',
  'automations',
  'run',
  'status'
] as const

export type TelegramCommandName = (typeof TELEGRAM_COMMAND_NAMES)[number]

export type HelpInfo = {
  botName: string
  orcaChatId: string | null
  syncOn: boolean
}

export type StatusInfo = {
  botUsername: string | null
  botName: string
  orcaChatId: string | null
  syncOn: boolean
  pollStatus: string
}

export type Messages = {
  commands: Record<TelegramCommandName, string>
  unauthorized: (userId: string) => string
  callbackUnauthorized: string
  unsupportedImage: string
  processingFailed: (detail: string) => string
  actionFailed: (detail: string) => string
  noBotsAvailable: string
  shortenedNote: string
  tableMarker: (n: number) => string
  tableCaption: (n: number) => string
  orcaUserMessageHeader: (botName: string) => string
  help: (info: HelpInfo) => string
  status: (info: StatusInfo) => string
  currentSuffix: string
  noBotsFound: string
  useUsage: string
  botNotFound: (name: string, available: string[]) => string
  switchedBot: (botName: string) => string
  switchedBotToast: (botName: string) => string
  botNotFoundRetry: string
  contextReset: (botName: string) => string
  contextResetToast: string
  homeChatNotFoundFor: (botName: string) => string
  homeChatNotFound: string
  boundHomeChat: (botName: string, chatId: string) => string
  homeChatBoundToast: string
  untitledChat: string
  noChats: string
  newChatButton: string
  bindUsage: string
  chatNotFound: (botName: string, chatId: string) => string
  chatGoneRetry: string
  boundChat: (botName: string, title: string) => string
  chatBoundToast: string
  renameUsage: string
  noBoundChat: string
  renamed: (title: string) => string
  renameFailed: (detail: string) => string
  syncState: (on: boolean) => string
  syncOnButton: string
  syncOffButton: string
  syncEnabled: string
  syncDisabled: string
  syncOnToast: string
  syncOffToast: string
  syncUsage: string
  noAutomations: string
  automationState: (enabled: boolean, lastRunStatus?: string | null) => string
  runButton: (name: string) => string
  automationsFailed: (detail: string) => string
  runUsage: string
  automationTriggered: (automationId: string) => string
  automationTriggeredToast: string
  runFailed: (detail: string) => string
}

const enOnOff = (on: boolean) => (on ? 'on' : 'off')

const en: Messages = {
  commands: {
    help: 'Show available commands',
    new: 'Start a fresh Orca chat session',
    home: 'Bind to current bot Home Chat',
    bots: 'List & switch Orca bots',
    use: 'Switch target Orca bot (/use <name>)',
    chats: 'List & switch recent Orca chats',
    bind: 'Bind to an Orca chat (/bind <id>)',
    rename: 'Rename bound Orca chat (/rename <title>)',
    sync: 'Toggle Orca -> TG sync (/sync on|off)',
    automations: 'List & trigger Orca automations',
    run: 'Run an automation now (/run <id>)',
    status: 'Show connection and session status'
  },
  unauthorized: (userId) =>
    `Access denied. Your Telegram ID is ${userId}. Add it to the allowlist in Orca's Telegram panel first.`,
  callbackUnauthorized: 'Access denied. Add your ID to the allowlist first.',
  unsupportedImage: 'This image format is not supported. Send a JPG, PNG, WEBP, GIF or BMP image.',
  processingFailed: (detail) => `Processing failed: ${detail}`,
  actionFailed: (detail) => `Action failed: ${detail}`,
  noBotsAvailable: 'No Orca bot found. Create at least one bot in Orca first.',
  shortenedNote: '(The reply was too long and was shortened. Open Orca to see the full text.)',
  tableMarker: (n) => `📊 **Table ${n}** (see image below)`,
  tableCaption: (n) => `Table ${n}`,
  orcaUserMessageHeader: (botName) => `🗣️ **You sent in Orca (${botName}):**`,
  help: ({ botName, orcaChatId, syncOn }) =>
    [
      `Current bot: ${botName || '(none found)'}`,
      `Current chat: ${orcaChatId || '(new chat, created with your next message)'}`,
      `Two-way sync (Orca -> TG): ${enOnOff(syncOn)}`,
      '',
      'Commands:',
      '/bots - List Orca bots and tap one to switch',
      '/use <name> - Switch the target bot',
      '/chats - List chats and tap one to bind it',
      "/home - Bind the current bot's Home Chat",
      '/new - Clear the context and start a new chat',
      '/bind <chatId> - Bind to a given Orca chat',
      '/rename <new title> - Rename the bound chat',
      '/sync [on|off] - Turn Orca -> Telegram sync on or off',
      '/automations - List and run automations',
      '/run <id> - Run an automation now',
      '/status - Show connection and chat status'
    ].join('\n'),
  status: ({ botUsername, botName, orcaChatId, syncOn, pollStatus }) =>
    [
      `Telegram bot: ${botUsername ? `@${botUsername}` : 'unknown'}`,
      `Target Orca bot: ${botName}`,
      `Bound chat ID: ${orcaChatId || '(none yet, your next message creates one)'}`,
      `Two-way sync (Orca -> TG): ${enOnOff(syncOn)}`,
      `Polling: ${pollStatus}`
    ].join('\n'),
  currentSuffix: ' (current)',
  noBotsFound: 'No Orca bots found.',
  useUsage: 'Usage: /use <bot name>',
  botNotFound: (name, available) =>
    `No bot named "${name}". Available bots: ${available.join(', ') || 'none'}`,
  switchedBot: (botName) => `Switched to bot: ${botName} (your next message starts a new chat)`,
  switchedBotToast: (botName) => `Switched to ${botName}`,
  botNotFoundRetry: 'Bot not found. Run /bots again.',
  contextReset: (botName) => `Context cleared. Your next message starts a new chat in ${botName}.`,
  contextResetToast: 'Context cleared',
  homeChatNotFoundFor: (botName) => `No Home Chat found for ${botName}.`,
  homeChatNotFound: 'Home Chat not found.',
  boundHomeChat: (botName, chatId) => `Bound to the Home Chat of ${botName} (${chatId}).`,
  homeChatBoundToast: 'Home Chat bound',
  untitledChat: '(untitled)',
  noChats: 'No chats available.',
  newChatButton: '➕ New chat',
  bindUsage: 'Usage: /bind <Orca chatId>',
  chatNotFound: (botName, chatId) => `No open chat ${chatId} found in ${botName}.`,
  chatGoneRetry: 'The chat is closed or no longer exists. Run /chats again.',
  boundChat: (botName, title) => `Bound to the ${botName} chat: ${title}`,
  chatBoundToast: 'Chat bound',
  renameUsage: 'Usage: /rename <new title>',
  noBoundChat: 'No Orca chat is bound yet. Send a message first, or bind a chat with /bind.',
  renamed: (title) => `Chat renamed to: ${title}`,
  renameFailed: (detail) => `Rename failed: ${detail}`,
  syncState: (on) => `Two-way sync (Orca -> TG) is ${enOnOff(on)}`,
  syncOnButton: 'Turn sync on',
  syncOffButton: 'Turn sync off',
  syncEnabled: 'Orca -> Telegram sync is on.',
  syncDisabled: 'Orca -> Telegram sync is off.',
  syncOnToast: 'Sync turned on',
  syncOffToast: 'Sync turned off',
  syncUsage: 'Usage: /sync [on|off]',
  noAutomations: 'No automations are set up.',
  automationState: (enabled, lastRunStatus) =>
    `${enabled ? 'enabled' : 'disabled'}${lastRunStatus ? `, last run: ${lastRunStatus}` : ''}`,
  runButton: (name) => `▶️ Run: ${name}`,
  automationsFailed: (detail) => `Could not list automations: ${detail}`,
  runUsage: 'Usage: /run <automationId> (see the IDs with /automations, or tap a button there to run one)',
  automationTriggered: (automationId) => `Automation started: ${automationId}`,
  automationTriggeredToast: 'Automation started',
  runFailed: (detail) => `Run failed: ${detail}`
}

// Agrees with "sincronização" and "automação", both feminine.
const ptOnOff = (on: boolean) => (on ? 'ativada' : 'desativada')

const ptBR: Messages = {
  commands: {
    help: 'Mostrar os comandos disponíveis',
    new: 'Iniciar uma nova conversa no Orca',
    home: 'Vincular o Home Chat do bot atual',
    bots: 'Listar e trocar bots do Orca',
    use: 'Trocar o bot do Orca (/use <nome>)',
    chats: 'Listar e trocar conversas recentes do Orca',
    bind: 'Vincular a uma conversa do Orca (/bind <id>)',
    rename: 'Renomear a conversa vinculada (/rename <título>)',
    sync: 'Ativar ou desativar a sincronização Orca -> TG (/sync on|off)',
    automations: 'Listar e executar automações do Orca',
    run: 'Executar uma automação agora (/run <id>)',
    status: 'Ver o status da conexão e da conversa'
  },
  unauthorized: (userId) =>
    `Acesso negado. Seu ID do Telegram é ${userId}. Adicione-o à lista de permitidos no painel Telegram do Orca.`,
  callbackUnauthorized: 'Acesso negado. Adicione seu ID à lista de permitidos primeiro.',
  unsupportedImage: 'Formato de imagem não suportado. Envie uma imagem JPG, PNG, WEBP, GIF ou BMP.',
  processingFailed: (detail) => `Falha no processamento: ${detail}`,
  actionFailed: (detail) => `Falha na ação: ${detail}`,
  noBotsAvailable: 'Nenhum bot do Orca encontrado. Crie pelo menos um bot no Orca primeiro.',
  shortenedNote: '(A resposta era longa demais e foi encurtada. Abra o Orca para ver o texto completo.)',
  tableMarker: (n) => `📊 **Tabela ${n}** (veja a imagem abaixo)`,
  tableCaption: (n) => `Tabela ${n}`,
  orcaUserMessageHeader: (botName) => `🗣️ **Você enviou no Orca (${botName}):**`,
  help: ({ botName, orcaChatId, syncOn }) =>
    [
      `Bot atual: ${botName || '(nenhum encontrado)'}`,
      `Conversa atual: ${orcaChatId || '(nova conversa, criada com sua próxima mensagem)'}`,
      `Sincronização bidirecional (Orca -> TG): ${ptOnOff(syncOn)}`,
      '',
      'Comandos:',
      '/bots - Listar os bots do Orca e tocar em um para trocar',
      '/use <nome> - Trocar o bot de destino',
      '/chats - Listar as conversas e tocar em uma para vincular',
      '/home - Vincular o Home Chat do bot atual',
      '/new - Limpar o contexto e iniciar uma nova conversa',
      '/bind <chatId> - Vincular a uma conversa específica do Orca',
      '/rename <novo título> - Renomear a conversa vinculada',
      '/sync [on|off] - Ativar ou desativar a sincronização Orca -> Telegram',
      '/automations - Listar e executar automações',
      '/run <id> - Executar uma automação agora',
      '/status - Ver o status da conexão e da conversa'
    ].join('\n'),
  status: ({ botUsername, botName, orcaChatId, syncOn, pollStatus }) =>
    [
      `Bot do Telegram: ${botUsername ? `@${botUsername}` : 'desconhecido'}`,
      `Bot do Orca de destino: ${botName}`,
      `ID da conversa vinculada: ${orcaChatId || '(nenhuma ainda, sua próxima mensagem cria uma)'}`,
      `Sincronização bidirecional (Orca -> TG): ${ptOnOff(syncOn)}`,
      `Polling: ${pollStatus}`
    ].join('\n'),
  currentSuffix: ' (atual)',
  noBotsFound: 'Nenhum bot do Orca encontrado.',
  useUsage: 'Uso: /use <nome do bot>',
  botNotFound: (name, available) =>
    `Nenhum bot chamado "${name}". Bots disponíveis: ${available.join(', ') || 'nenhum'}`,
  switchedBot: (botName) => `Bot trocado para: ${botName} (sua próxima mensagem inicia uma nova conversa)`,
  switchedBotToast: (botName) => `Trocado para ${botName}`,
  botNotFoundRetry: 'Bot não encontrado. Execute /bots de novo.',
  contextReset: (botName) => `Contexto limpo. Sua próxima mensagem inicia uma nova conversa em ${botName}.`,
  contextResetToast: 'Contexto limpo',
  homeChatNotFoundFor: (botName) => `Nenhum Home Chat disponível para ${botName}.`,
  homeChatNotFound: 'Home Chat não encontrado.',
  boundHomeChat: (botName, chatId) => `Vinculado ao Home Chat de ${botName} (${chatId}).`,
  homeChatBoundToast: 'Home Chat vinculado',
  untitledChat: '(sem título)',
  noChats: 'Nenhuma conversa disponível.',
  newChatButton: '➕ Nova conversa',
  bindUsage: 'Uso: /bind <chatId do Orca>',
  chatNotFound: (botName, chatId) => `Nenhuma conversa aberta ${chatId} encontrada em ${botName}.`,
  chatGoneRetry: 'A conversa foi fechada ou não existe mais. Execute /chats de novo.',
  boundChat: (botName, title) => `Vinculado à conversa de ${botName}: ${title}`,
  chatBoundToast: 'Conversa vinculada',
  renameUsage: 'Uso: /rename <novo título>',
  noBoundChat: 'Ainda não há conversa do Orca vinculada. Envie uma mensagem primeiro ou vincule uma com /bind.',
  renamed: (title) => `Conversa renomeada para: ${title}`,
  renameFailed: (detail) => `Falha ao renomear: ${detail}`,
  syncState: (on) => `Sincronização bidirecional (Orca -> TG): ${ptOnOff(on)}`,
  syncOnButton: 'Ativar sincronização',
  syncOffButton: 'Desativar sincronização',
  syncEnabled: 'Sincronização Orca -> Telegram ativada.',
  syncDisabled: 'Sincronização Orca -> Telegram desativada.',
  syncOnToast: 'Sincronização ativada',
  syncOffToast: 'Sincronização desativada',
  syncUsage: 'Uso: /sync [on|off]',
  noAutomations: 'Nenhuma automação configurada.',
  automationState: (enabled, lastRunStatus) =>
    `${ptOnOff(enabled)}${lastRunStatus ? `, última execução: ${lastRunStatus}` : ''}`,
  runButton: (name) => `▶️ Executar: ${name}`,
  automationsFailed: (detail) => `Falha ao listar as automações: ${detail}`,
  runUsage: 'Uso: /run <automationId> (veja os IDs com /automations ou toque em um botão de lá para executar)',
  automationTriggered: (automationId) => `Automação iniciada: ${automationId}`,
  automationTriggeredToast: 'Automação iniciada',
  runFailed: (detail) => `Falha ao executar: ${detail}`
}

const zhOnOff = (on: boolean) => (on ? '开启' : '关闭')

const zhCN: Messages = {
  commands: {
    help: '显示可用指令',
    new: '开启新的 Orca 会话',
    home: '绑定当前 Bot 的 Home Chat',
    bots: '列出并切换 Orca Bot',
    use: '切换目标 Orca Bot (/use <名称>)',
    chats: '列出并切换最近的 Orca 会话',
    bind: '绑定到 Orca 会话 (/bind <id>)',
    rename: '重命名绑定的 Orca 会话 (/rename <标题>)',
    sync: '开关 Orca -> TG 同步 (/sync on|off)',
    automations: '列出并触发 Orca 自动化任务',
    run: '立即执行自动化任务 (/run <id>)',
    status: '查看连接与会话状态'
  },
  unauthorized: (userId) =>
    `未授权访问。你的 Telegram ID 是 ${userId}，请先在 Orca 的 Telegram 面板中将其加入白名单。`,
  callbackUnauthorized: '未授权访问，请先加入白名单。',
  unsupportedImage: '暂不支持该图片格式，请发送 JPG、PNG、WEBP、GIF 或 BMP 图片。',
  processingFailed: (detail) => `处理失败：${detail}`,
  actionFailed: (detail) => `操作失败：${detail}`,
  noBotsAvailable: '当前未检测到可用的 Orca Bot，请先在 Orca 中创建至少一个 Bot。',
  shortenedNote: '（回复过长已截断，请在 Orca 中查看完整内容）',
  tableMarker: (n) => `📊 **表格 ${n}**（见下方图片）`,
  tableCaption: (n) => `表格 ${n}`,
  orcaUserMessageHeader: (botName) => `🗣️ **你在 Orca (${botName}) 发送：**`,
  help: ({ botName, orcaChatId, syncOn }) =>
    [
      `当前连接 Bot：${botName || '(未检测到)'}`,
      `当前会话：${orcaChatId || '(新会话，将在下一条消息创建)'}`,
      `双向同步 (Orca -> TG)：${zhOnOff(syncOn)}`,
      '',
      '可用指令：',
      '/bots - 列出并点击切换 Orca Bot',
      '/use <名称> - 切换目标 Bot',
      '/chats - 查看并点击绑定历史会话',
      '/home - 绑定当前 Bot 的 Home Chat',
      '/new - 清空当前上下文，开启新对话',
      '/bind <chatId> - 绑定到指定的 Orca 会话',
      '/rename <新标题> - 重命名当前绑定的会话',
      '/sync [on|off] - 开关 Orca 端消息双向同步',
      '/automations - 查看并触发自动化任务',
      '/run <id> - 立即执行指定自动化任务',
      '/status - 查看连接与会话状态'
    ].join('\n'),
  status: ({ botUsername, botName, orcaChatId, syncOn, pollStatus }) =>
    [
      `Telegram Bot: ${botUsername ? `@${botUsername}` : '未知'}`,
      `目标 Orca Bot: ${botName}`,
      `绑定会话 ID: ${orcaChatId || '(未创建，发消息自动新建)'}`,
      `双向同步 (Orca -> TG): ${zhOnOff(syncOn)}`,
      `轮询状态: ${pollStatus}`
    ].join('\n'),
  currentSuffix: ' (当前)',
  noBotsFound: '未检测到 Orca Bot。',
  useUsage: '用法：/use <Bot名称>',
  botNotFound: (name, available) => `未找到名为 "${name}" 的 Bot。可用 Bot：${available.join('、') || '无'}`,
  switchedBot: (botName) => `已切换到 Bot：${botName}（下一条消息将新建会话）`,
  switchedBotToast: (botName) => `已切换到 ${botName}`,
  botNotFoundRetry: '未找到该 Bot，请重新运行 /bots。',
  contextReset: (botName) => `已重置上下文，下一条消息将在 ${botName} 中创建新会话。`,
  contextResetToast: '已重置上下文',
  homeChatNotFoundFor: (botName) => `未找到 ${botName} 的可用 Home Chat。`,
  homeChatNotFound: '未找到 Home Chat。',
  boundHomeChat: (botName, chatId) => `已绑定到 ${botName} 的 Home Chat（${chatId}）。`,
  homeChatBoundToast: '已绑定 Home Chat',
  untitledChat: '(无标题)',
  noChats: '暂无可用会话。',
  newChatButton: '➕ 新建会话',
  bindUsage: '用法：/bind <Orca chatId>',
  chatNotFound: (botName, chatId) => `在 ${botName} 中未找到未关闭的会话 ${chatId}。`,
  chatGoneRetry: '会话已关闭或不存在，请重新运行 /chats。',
  boundChat: (botName, title) => `已绑定到 ${botName} 的会话：${title}`,
  chatBoundToast: '已绑定会话',
  renameUsage: '用法：/rename <新标题>',
  noBoundChat: '当前还没有绑定的 Orca 会话，请先发送一条消息或用 /bind 绑定会话。',
  renamed: (title) => `已将当前会话重命名为：${title}`,
  renameFailed: (detail) => `重命名失败：${detail}`,
  syncState: (on) => `双向同步 (Orca -> TG) 当前状态：${zhOnOff(on)}`,
  syncOnButton: '开启双向同步',
  syncOffButton: '关闭双向同步',
  syncEnabled: '已开启 Orca -> Telegram 双向同步。',
  syncDisabled: '已关闭 Orca -> Telegram 双向同步。',
  syncOnToast: '已开启双向同步',
  syncOffToast: '已关闭双向同步',
  syncUsage: '用法：/sync [on|off]',
  noAutomations: '当前没有已配置的自动化任务。',
  automationState: (enabled, lastRunStatus) =>
    `${enabled ? '启用' : '停用'}${lastRunStatus ? `，上次：${lastRunStatus}` : ''}`,
  runButton: (name) => `▶️ 运行：${name}`,
  automationsFailed: (detail) => `获取自动化任务失败：${detail}`,
  runUsage: '用法：/run <automationId>（可先用 /automations 查看任务 ID 或直接点击按钮运行）',
  automationTriggered: (automationId) => `已触发自动化任务：${automationId}`,
  automationTriggeredToast: '已触发自动化任务',
  runFailed: (detail) => `触发失败：${detail}`
}

const CATALOG: Record<ReplyLanguage, Messages> = {
  en,
  'pt-BR': ptBR,
  'zh-CN': zhCN
}

export function normalizeLanguage(value: unknown): ReplyLanguage {
  return REPLY_LANGUAGES.find((lang) => lang === value) ?? 'en'
}

export function t(lang: ReplyLanguage): Messages {
  return CATALOG[lang]
}
