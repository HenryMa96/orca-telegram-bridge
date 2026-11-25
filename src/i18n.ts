// Texts the bridge sends to Telegram, in the language each bridge's `replyLanguage` chose.
// Log entries and the panel stay English; only what the Telegram user reads is translated.

export type ReplyLanguage = 'en' | 'pt-BR' | 'es' | 'zh-CN'

export const REPLY_LANGUAGES: ReplyLanguage[] = ['en', 'pt-BR', 'es', 'zh-CN']

// How the Orca bot is told which language a chat speaks.
export const LANGUAGE_NAMES: Record<ReplyLanguage, string> = {
  en: 'English',
  'pt-BR': 'Brazilian Portuguese',
  es: 'Spanish',
  'zh-CN': 'Simplified Chinese'
}

// What a bridge stores: a fixed language, or 'auto' = the sender's Telegram language for the
// bridge's own texts (else the chat's last known one, else English), and the language of their
// message for the Orca bot's answer.
export type ReplyLanguageSetting = ReplyLanguage | 'auto'

// Telegram slash command menu, in menu order. `/use` is not listed: each Telegram bot is pinned
// to one Orca bot, and `/use` only answers that.
export const TELEGRAM_COMMAND_NAMES = [
  'help',
  'new',
  'home',
  'bots',
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
  // Absent when the sender's role may not bind chats here: the bound chat id is not theirs to see.
  orcaChatId?: string | null
  // Absent when the sender's role may not turn sync on or off.
  syncOn?: boolean
  // The commands this sender's role may use; /help lists only these.
  commands: readonly TelegramCommandName[]
}

export type StatusInfo = {
  botUsername: string | null
  botName: string
  // Absent when the sender's role may not bind chats or switch sync, as in HelpInfo.
  orcaChatId?: string | null
  syncOn?: boolean
  pollStatus: string
}

// Keeps the help lines of the allowed commands; each line starts with its command ('/bind <chatId> - …').
function allowedLines(lines: string[], allowed: readonly TelegramCommandName[]): string[] {
  return lines.filter((line) => allowed.includes(line.slice(1).split(/\s/)[0] as TelegramCommandName))
}

// "20s" under a minute, "1 min 30 s" from then on (the units differ by language).
function elapsedText(ms: number, units: { s: string; min: string; minS: string }): string {
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}${units.s}`
  const seconds = total % 60
  return `${Math.floor(total / 60)}${units.min}${seconds ? ` ${seconds}${units.minS}` : ''}`
}

const LATIN_UNITS = { s: 's', min: ' min', minS: ' s' }

export type Messages = {
  commands: Record<TelegramCommandName, string>
  unauthorized: (userId: string) => string
  callbackUnauthorized: string
  // A command or button the sender's role does not allow.
  notAllowedForRole: string
  unsupportedImage: string
  // A file above the 20 MB a Telegram bot may download.
  fileTooLarge: string
  // While a slow answer is awaited: the time since the message was sent to the Orca bot.
  workingLine: (elapsedMs: number) => string
  // The one plain line for a failed answer, by kind; the technical cause stays in the Logs.
  errorTimeout: string
  errorOrcaUnreachable: string
  errorGeneric: string
  retryButton: string
  detailsButton: string
  // Toasts for [Try again] tapped by someone else, or after the failure was forgotten.
  retryOnlySender: string
  retryExpired: string
  voiceDisabled: string
  voiceFailed: (reason: string) => string
  // Short reasons for voiceFailed.
  voiceTooLarge: string
  voiceEmpty: string
  // One line per file or URL from a bot reply that could not be sent; the reasons below fill it.
  attachmentFailed: (name: string, reason: string) => string
  attachmentMissing: string
  attachmentUnreadable: string
  attachmentTooLarge: string
  attachmentNotAllowed: string
  attachmentNotImage: string
  attachmentRejected: string
  attachmentNeedsAllowlist: string
  actionFailed: (detail: string) => string
  noBotsAvailable: string
  shortenedNote: string
  tableMarker: (n: number) => string
  tableCaption: (n: number) => string
  orcaUserMessageHeader: (botName: string) => string
  help: (info: HelpInfo) => string
  status: (info: StatusInfo) => string
  currentSuffix: string
  linkedSuffix: string
  noBotsFound: string
  // The answer to `/use` and to an old bot-switch button.
  botPinned: (botName: string) => string
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
  // The line a group gets when a member changes its shared state (groupAuditNotice); `who` is the
  // member's label ("@joao" or "Ann (123)").
  groupNotice: GroupNotices
}

export type GroupNotices = {
  new: (who: string) => string
  home: (who: string) => string
  bind: (who: string) => string
  rename: (who: string) => string
  sync: (who: string, on: boolean) => string
  run: (who: string, automation: string) => string
}

const enOnOff = (on: boolean) => (on ? 'on' : 'off')

const en: Messages = {
  commands: {
    help: 'Show available commands',
    new: 'Start a fresh Orca chat session',
    home: 'Bind to current bot Home Chat',
    bots: 'List the Orca bots',
    chats: 'List & switch recent Orca chats',
    bind: 'Bind to an Orca chat (/bind <id>)',
    rename: 'Rename bound Orca chat (/rename <title>)',
    sync: 'Toggle Orca -> TG sync (/sync on|off)',
    automations: 'List & trigger Orca automations',
    run: 'Run an automation now (/run <id>)',
    status: 'Show connection and session status'
  },
  unauthorized: (userId) =>
    `Not authorized. Your Telegram ID is ${userId}. Ask the bot owner to add it.`,
  callbackUnauthorized: 'Access denied. Add your ID to the allowlist first.',
  notAllowedForRole: "This isn't available for you. Ask the bot's owner.",
  unsupportedImage: 'This image format is not supported. Send a JPG, PNG, WEBP, GIF or BMP image.',
  fileTooLarge: 'This file is larger than 20 MB, the most a Telegram bot can download. Send a smaller file or a link.',
  workingLine: (elapsedMs) => `Working… ${elapsedText(elapsedMs, LATIN_UNITS)}`,
  errorTimeout: 'The Orca bot is still working and went past the wait time. Try again in a few minutes.',
  errorOrcaUnreachable: "I couldn't reach Orca on this computer.",
  errorGeneric: 'Something went wrong while answering.',
  retryButton: 'Try again',
  detailsButton: 'Details',
  retryOnlySender: 'Only the person who asked can retry.',
  retryExpired: 'This message expired.',
  voiceDisabled: 'Voice messages are not enabled for this bot. Please send text.',
  voiceFailed: (reason) => `Could not transcribe the voice message: ${reason}`,
  voiceTooLarge: 'the file is larger than 20 MB',
  voiceEmpty: 'no speech was recognized',
  attachmentFailed: (name, reason) => `Could not attach ${name}: ${reason}`,
  attachmentMissing: 'the file was not found',
  attachmentUnreadable: 'the file could not be read',
  attachmentTooLarge: 'the file is larger than 50 MB',
  attachmentNotAllowed: 'this file type or folder is not allowed',
  attachmentNotImage: 'the file is not a valid image',
  attachmentRejected: 'Telegram did not accept it',
  attachmentNeedsAllowlist: 'Files from this computer are only sent when the bot is restricted to Allowed Telegram IDs.',
  actionFailed: (detail) => `Action failed: ${detail}`,
  noBotsAvailable: 'No Orca bot found. Create at least one bot in Orca first.',
  shortenedNote: '(The reply was too long and was shortened. Open Orca to see the full text.)',
  tableMarker: (n) => `📊 **Table ${n}** (see image below)`,
  tableCaption: (n) => `Table ${n}`,
  orcaUserMessageHeader: (botName) => `🗣️ **You sent in Orca (${botName}):**`,
  help: ({ botName, orcaChatId, syncOn, commands }) =>
    [
      `Current bot: ${botName || '(none found)'}`,
      ...(orcaChatId === undefined ? [] : [`Current chat: ${orcaChatId || '(new chat, created with your next message)'}`]),
      ...(syncOn === undefined ? [] : [`Two-way sync (Orca -> TG): ${enOnOff(syncOn)}`]),
      '',
      'Commands:',
      ...allowedLines(
        [
          '/bots - List the Orca bots (this Telegram bot talks to one of them)',
          '/chats - List chats and tap one to bind it',
          "/home - Bind the current bot's Home Chat",
          '/new - Clear the context and start a new chat',
          '/bind <chatId> - Bind to a given Orca chat',
          '/rename <new title> - Rename the bound chat',
          '/sync [on|off] - Turn Orca -> Telegram sync on or off',
          '/automations - List and run automations',
          '/run <id> - Run an automation now',
          '/status - Show connection and chat status'
        ],
        commands
      )
    ].join('\n'),
  status: ({ botUsername, botName, orcaChatId, syncOn, pollStatus }) =>
    [
      `Telegram bot: ${botUsername ? `@${botUsername}` : 'unknown'}`,
      `Target Orca bot: ${botName}`,
      ...(orcaChatId === undefined ? [] : [`Bound chat ID: ${orcaChatId || '(none yet, your next message creates one)'}`]),
      ...(syncOn === undefined ? [] : [`Two-way sync (Orca -> TG): ${enOnOff(syncOn)}`]),
      `Polling: ${pollStatus}`
    ].join('\n'),
  currentSuffix: ' (current)',
  linkedSuffix: ' (linked)',
  noBotsFound: 'No Orca bots found.',
  botPinned: (botName) =>
    `This Telegram bot is linked to ${botName || 'the first Orca bot'}. Ask the owner to change it in Orca.`,
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
  runFailed: (detail) => `Run failed: ${detail}`,
  groupNotice: {
    new: (who) => `${who} started a new chat`,
    home: (who) => `${who} switched to the Home Chat`,
    bind: (who) => `${who} switched to another Orca chat`,
    rename: (who) => `${who} renamed the Orca chat`,
    sync: (who, on) => `${who} turned Orca sync ${enOnOff(on)}`,
    run: (who, automation) => `${who} ran ${automation}`
  }
}

// Agrees with "sincronização" and "automação", both feminine.
const ptOnOff = (on: boolean) => (on ? 'ativada' : 'desativada')

const ptBR: Messages = {
  commands: {
    help: 'Mostrar os comandos disponíveis',
    new: 'Iniciar uma nova conversa no Orca',
    home: 'Vincular o Home Chat do bot atual',
    bots: 'Listar os bots do Orca',
    chats: 'Listar e trocar conversas recentes do Orca',
    bind: 'Vincular a uma conversa do Orca (/bind <id>)',
    rename: 'Renomear a conversa vinculada (/rename <título>)',
    sync: 'Ativar ou desativar a sincronização Orca -> TG (/sync on|off)',
    automations: 'Listar e executar automações do Orca',
    run: 'Executar uma automação agora (/run <id>)',
    status: 'Ver o status da conexão e da conversa'
  },
  unauthorized: (userId) =>
    `Sem autorização. Seu ID do Telegram é ${userId}. Peça ao dono do bot para adicioná-lo.`,
  callbackUnauthorized: 'Acesso negado. Adicione seu ID à lista de permitidos primeiro.',
  notAllowedForRole: 'Isto não está disponível para você. Fale com o dono do bot.',
  unsupportedImage: 'Formato de imagem não suportado. Envie uma imagem JPG, PNG, WEBP, GIF ou BMP.',
  fileTooLarge: 'Este arquivo passa de 20 MB, o máximo que um bot do Telegram consegue baixar. Envie um arquivo menor ou um link.',
  workingLine: (elapsedMs) => `Trabalhando… ${elapsedText(elapsedMs, LATIN_UNITS)}`,
  errorTimeout: 'O bot do Orca ainda está trabalhando e passou do tempo de espera. Tente de novo em alguns minutos.',
  errorOrcaUnreachable: 'Não consegui falar com o Orca neste computador.',
  errorGeneric: 'Algo deu errado ao responder.',
  retryButton: 'Tentar de novo',
  detailsButton: 'Detalhes',
  retryOnlySender: 'Só quem perguntou pode tentar de novo.',
  retryExpired: 'Esta mensagem expirou.',
  voiceDisabled: 'Mensagens de voz não estão ativadas para este bot. Envie texto.',
  voiceFailed: (reason) => `Não foi possível transcrever a mensagem de voz: ${reason}`,
  voiceTooLarge: 'o arquivo passa de 20 MB',
  voiceEmpty: 'nenhuma fala foi reconhecida',
  attachmentFailed: (name, reason) => `Não foi possível anexar ${name}: ${reason}`,
  attachmentMissing: 'o arquivo não foi encontrado',
  attachmentUnreadable: 'o arquivo não pôde ser lido',
  attachmentTooLarge: 'o arquivo passa de 50 MB',
  attachmentNotAllowed: 'este tipo de arquivo ou pasta não é permitido',
  attachmentNotImage: 'o arquivo não é uma imagem válida',
  attachmentRejected: 'o Telegram não o aceitou',
  attachmentNeedsAllowlist:
    'Arquivos deste computador só são enviados quando o bot está restrito aos IDs do Telegram permitidos.',
  actionFailed: (detail) => `Falha na ação: ${detail}`,
  noBotsAvailable: 'Nenhum bot do Orca encontrado. Crie pelo menos um bot no Orca primeiro.',
  shortenedNote: '(A resposta era longa demais e foi encurtada. Abra o Orca para ver o texto completo.)',
  tableMarker: (n) => `📊 **Tabela ${n}** (veja a imagem abaixo)`,
  tableCaption: (n) => `Tabela ${n}`,
  orcaUserMessageHeader: (botName) => `🗣️ **Você enviou no Orca (${botName}):**`,
  help: ({ botName, orcaChatId, syncOn, commands }) =>
    [
      `Bot atual: ${botName || '(nenhum encontrado)'}`,
      ...(orcaChatId === undefined ? [] : [`Conversa atual: ${orcaChatId || '(nova conversa, criada com sua próxima mensagem)'}`]),
      ...(syncOn === undefined ? [] : [`Sincronização bidirecional (Orca -> TG): ${ptOnOff(syncOn)}`]),
      '',
      'Comandos:',
      ...allowedLines(
        [
          '/bots - Listar os bots do Orca (este bot do Telegram fala com um deles)',
          '/chats - Listar as conversas e tocar em uma para vincular',
          '/home - Vincular o Home Chat do bot atual',
          '/new - Limpar o contexto e iniciar uma nova conversa',
          '/bind <chatId> - Vincular a uma conversa específica do Orca',
          '/rename <novo título> - Renomear a conversa vinculada',
          '/sync [on|off] - Ativar ou desativar a sincronização Orca -> Telegram',
          '/automations - Listar e executar automações',
          '/run <id> - Executar uma automação agora',
          '/status - Ver o status da conexão e da conversa'
        ],
        commands
      )
    ].join('\n'),
  status: ({ botUsername, botName, orcaChatId, syncOn, pollStatus }) =>
    [
      `Bot do Telegram: ${botUsername ? `@${botUsername}` : 'desconhecido'}`,
      `Bot do Orca de destino: ${botName}`,
      ...(orcaChatId === undefined ? [] : [`ID da conversa vinculada: ${orcaChatId || '(nenhuma ainda, sua próxima mensagem cria uma)'}`]),
      ...(syncOn === undefined ? [] : [`Sincronização bidirecional (Orca -> TG): ${ptOnOff(syncOn)}`]),
      `Polling: ${pollStatus}`
    ].join('\n'),
  currentSuffix: ' (atual)',
  linkedSuffix: ' (vinculado)',
  noBotsFound: 'Nenhum bot do Orca encontrado.',
  botPinned: (botName) =>
    `Este bot do Telegram está vinculado ${botName ? `a ${botName}` : 'ao primeiro bot do Orca'}. Peça ao dono para trocar no Orca.`,
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
  runFailed: (detail) => `Falha ao executar: ${detail}`,
  groupNotice: {
    new: (who) => `${who} iniciou uma nova conversa`,
    home: (who) => `${who} mudou para o Home Chat`,
    bind: (who) => `${who} mudou para outra conversa do Orca`,
    rename: (who) => `${who} renomeou a conversa do Orca`,
    sync: (who, on) => `${who} ${on ? 'ativou' : 'desativou'} a sincronização do Orca`,
    run: (who, automation) => `${who} executou ${automation}`
  }
}

const esOnOff = (on: boolean) => (on ? 'activada' : 'desactivada')

const es: Messages = {
  commands: {
    help: 'Mostrar los comandos disponibles',
    new: 'Iniciar una nueva conversación en Orca',
    home: 'Vincular el Home Chat del bot actual',
    bots: 'Listar los bots de Orca',
    chats: 'Listar y cambiar conversaciones recientes de Orca',
    bind: 'Vincular a una conversación de Orca (/bind <id>)',
    rename: 'Renombrar la conversación vinculada (/rename <título>)',
    sync: 'Activar o desactivar la sincronización Orca -> TG (/sync on|off)',
    automations: 'Listar y ejecutar automatizaciones de Orca',
    run: 'Ejecutar una automatización ahora (/run <id>)',
    status: 'Ver el estado de la conexión y de la conversación'
  },
  unauthorized: (userId) =>
    `Sin autorización. Tu ID de Telegram es ${userId}. Pide al dueño del bot que lo agregue.`,
  callbackUnauthorized: 'Acceso denegado. Primero agrega tu ID a la lista de permitidos.',
  notAllowedForRole: 'Esto no está disponible para ti. Pregunta al dueño del bot.',
  unsupportedImage: 'Formato de imagen no compatible. Envía una imagen JPG, PNG, WEBP, GIF o BMP.',
  fileTooLarge: 'Este archivo supera los 20 MB, lo máximo que un bot de Telegram puede descargar. Envía un archivo más pequeño o un enlace.',
  workingLine: (elapsedMs) => `Trabajando… ${elapsedText(elapsedMs, LATIN_UNITS)}`,
  errorTimeout: 'El bot de Orca sigue trabajando y superó el tiempo de espera. Vuelve a intentarlo en unos minutos.',
  errorOrcaUnreachable: 'No pude conectar con Orca en esta computadora.',
  errorGeneric: 'Algo salió mal al responder.',
  retryButton: 'Reintentar',
  detailsButton: 'Detalles',
  retryOnlySender: 'Solo quien preguntó puede reintentar.',
  retryExpired: 'Este mensaje expiró.',
  voiceDisabled: 'Los mensajes de voz no están activados para este bot. Envía texto.',
  voiceFailed: (reason) => `No se pudo transcribir el mensaje de voz: ${reason}`,
  voiceTooLarge: 'el archivo supera los 20 MB',
  voiceEmpty: 'no se reconoció ninguna voz',
  attachmentFailed: (name, reason) => `No se pudo adjuntar ${name}: ${reason}`,
  attachmentMissing: 'no se encontró el archivo',
  attachmentUnreadable: 'no se pudo leer el archivo',
  attachmentTooLarge: 'el archivo supera los 50 MB',
  attachmentNotAllowed: 'este tipo de archivo o carpeta no está permitido',
  attachmentNotImage: 'el archivo no es una imagen válida',
  attachmentRejected: 'Telegram no lo aceptó',
  attachmentNeedsAllowlist:
    'Los archivos de esta computadora solo se envían cuando el bot está restringido a los IDs de Telegram permitidos.',
  actionFailed: (detail) => `La acción falló: ${detail}`,
  noBotsAvailable: 'No se encontró ningún bot de Orca. Crea al menos un bot en Orca primero.',
  shortenedNote: '(La respuesta era demasiado larga y se acortó. Abre Orca para ver el texto completo.)',
  tableMarker: (n) => `📊 **Tabla ${n}** (mira la imagen abajo)`,
  tableCaption: (n) => `Tabla ${n}`,
  orcaUserMessageHeader: (botName) => `🗣️ **Enviaste en Orca (${botName}):**`,
  help: ({ botName, orcaChatId, syncOn, commands }) =>
    [
      `Bot actual: ${botName || '(ninguno encontrado)'}`,
      ...(orcaChatId === undefined ? [] : [`Conversación actual: ${orcaChatId || '(nueva conversación, se crea con tu próximo mensaje)'}`]),
      ...(syncOn === undefined ? [] : [`Sincronización bidireccional (Orca -> TG): ${esOnOff(syncOn)}`]),
      '',
      'Comandos:',
      ...allowedLines(
        [
          '/bots - Listar los bots de Orca (este bot de Telegram habla con uno de ellos)',
          '/chats - Listar las conversaciones y tocar una para vincularla',
          '/home - Vincular el Home Chat del bot actual',
          '/new - Borrar el contexto e iniciar una nueva conversación',
          '/bind <chatId> - Vincular a una conversación específica de Orca',
          '/rename <nuevo título> - Renombrar la conversación vinculada',
          '/sync [on|off] - Activar o desactivar la sincronización Orca -> Telegram',
          '/automations - Listar y ejecutar automatizaciones',
          '/run <id> - Ejecutar una automatización ahora',
          '/status - Ver el estado de la conexión y de la conversación'
        ],
        commands
      )
    ].join('\n'),
  status: ({ botUsername, botName, orcaChatId, syncOn, pollStatus }) =>
    [
      `Bot de Telegram: ${botUsername ? `@${botUsername}` : 'desconocido'}`,
      `Bot de Orca de destino: ${botName}`,
      ...(orcaChatId === undefined ? [] : [`ID de la conversación vinculada: ${orcaChatId || '(ninguna todavía, tu próximo mensaje crea una)'}`]),
      ...(syncOn === undefined ? [] : [`Sincronización bidireccional (Orca -> TG): ${esOnOff(syncOn)}`]),
      `Polling: ${pollStatus}`
    ].join('\n'),
  currentSuffix: ' (actual)',
  linkedSuffix: ' (vinculado)',
  noBotsFound: 'No se encontró ningún bot de Orca.',
  botPinned: (botName) =>
    `Este bot de Telegram está vinculado ${botName ? `a ${botName}` : 'al primer bot de Orca'}. Pide al dueño que lo cambie en Orca.`,
  contextReset: (botName) => `Contexto borrado. Tu próximo mensaje inicia una nueva conversación en ${botName}.`,
  contextResetToast: 'Contexto borrado',
  homeChatNotFoundFor: (botName) => `No hay Home Chat disponible para ${botName}.`,
  homeChatNotFound: 'No se encontró el Home Chat.',
  boundHomeChat: (botName, chatId) => `Vinculado al Home Chat de ${botName} (${chatId}).`,
  homeChatBoundToast: 'Home Chat vinculado',
  untitledChat: '(sin título)',
  noChats: 'No hay conversaciones disponibles.',
  newChatButton: '➕ Nueva conversación',
  bindUsage: 'Uso: /bind <chatId de Orca>',
  chatNotFound: (botName, chatId) => `No se encontró una conversación abierta ${chatId} en ${botName}.`,
  chatGoneRetry: 'La conversación se cerró o ya no existe. Ejecuta /chats de nuevo.',
  boundChat: (botName, title) => `Vinculado a la conversación de ${botName}: ${title}`,
  chatBoundToast: 'Conversación vinculada',
  renameUsage: 'Uso: /rename <nuevo título>',
  noBoundChat: 'Todavía no hay una conversación de Orca vinculada. Envía un mensaje primero o vincula una con /bind.',
  renamed: (title) => `Conversación renombrada a: ${title}`,
  renameFailed: (detail) => `Error al renombrar: ${detail}`,
  syncState: (on) => `Sincronización bidireccional (Orca -> TG): ${esOnOff(on)}`,
  syncOnButton: 'Activar sincronización',
  syncOffButton: 'Desactivar sincronización',
  syncEnabled: 'Sincronización Orca -> Telegram activada.',
  syncDisabled: 'Sincronización Orca -> Telegram desactivada.',
  syncOnToast: 'Sincronización activada',
  syncOffToast: 'Sincronización desactivada',
  syncUsage: 'Uso: /sync [on|off]',
  noAutomations: 'No hay automatizaciones configuradas.',
  automationState: (enabled, lastRunStatus) =>
    `${esOnOff(enabled)}${lastRunStatus ? `, última ejecución: ${lastRunStatus}` : ''}`,
  runButton: (name) => `▶️ Ejecutar: ${name}`,
  automationsFailed: (detail) => `Error al listar las automatizaciones: ${detail}`,
  runUsage: 'Uso: /run <automationId> (mira los IDs con /automations o toca un botón allí para ejecutarla)',
  automationTriggered: (automationId) => `Automatización iniciada: ${automationId}`,
  automationTriggeredToast: 'Automatización iniciada',
  runFailed: (detail) => `Error al ejecutar: ${detail}`,
  groupNotice: {
    new: (who) => `${who} inició una nueva conversación`,
    home: (who) => `${who} cambió al Home Chat`,
    bind: (who) => `${who} cambió a otra conversación de Orca`,
    rename: (who) => `${who} renombró la conversación de Orca`,
    sync: (who, on) => `${who} ${on ? 'activó' : 'desactivó'} la sincronización de Orca`,
    run: (who, automation) => `${who} ejecutó ${automation}`
  }
}

const zhOnOff = (on: boolean) => (on ? '开启' : '关闭')

const zhCN: Messages = {
  commands: {
    help: '显示可用指令',
    new: '开启新的 Orca 会话',
    home: '绑定当前 Bot 的 Home Chat',
    bots: '列出 Orca Bot',
    chats: '列出并切换最近的 Orca 会话',
    bind: '绑定到 Orca 会话 (/bind <id>)',
    rename: '重命名绑定的 Orca 会话 (/rename <标题>)',
    sync: '开关 Orca -> TG 同步 (/sync on|off)',
    automations: '列出并触发 Orca 自动化任务',
    run: '立即执行自动化任务 (/run <id>)',
    status: '查看连接与会话状态'
  },
  unauthorized: (userId) =>
    `未获授权。你的 Telegram ID 是 ${userId}，请联系机器人所有者添加。`,
  callbackUnauthorized: '未授权访问，请先加入白名单。',
  notAllowedForRole: '此功能对你不可用，请联系机器人的所有者。',
  unsupportedImage: '暂不支持该图片格式，请发送 JPG、PNG、WEBP、GIF 或 BMP 图片。',
  fileTooLarge: '该文件超过 20 MB，这是 Telegram 机器人能下载的上限。请发送更小的文件或链接。',
  workingLine: (elapsedMs) => `处理中… ${elapsedText(elapsedMs, { s: ' 秒', min: ' 分', minS: ' 秒' })}`,
  errorTimeout: 'Orca Bot 仍在处理，已超过等待时间。请过几分钟再试。',
  errorOrcaUnreachable: '无法连接到这台电脑上的 Orca。',
  errorGeneric: '回答时出现问题。',
  retryButton: '重试',
  detailsButton: '详情',
  retryOnlySender: '只有提问的人可以重试。',
  retryExpired: '此消息已过期。',
  voiceDisabled: '此机器人未启用语音消息，请发送文字。',
  voiceFailed: (reason) => `语音消息转写失败：${reason}`,
  voiceTooLarge: '文件超过 20 MB',
  voiceEmpty: '未识别到语音内容',
  attachmentFailed: (name, reason) => `无法附加 ${name}：${reason}`,
  attachmentMissing: '找不到该文件',
  attachmentUnreadable: '无法读取该文件',
  attachmentTooLarge: '文件超过 50 MB',
  attachmentNotAllowed: '不允许发送此类型或此文件夹中的文件',
  attachmentNotImage: '该文件不是有效的图片',
  attachmentRejected: 'Telegram 未接受该文件',
  attachmentNeedsAllowlist: '仅当机器人限定为允许的 Telegram ID 时，才会发送这台电脑上的文件。',
  actionFailed: (detail) => `操作失败：${detail}`,
  noBotsAvailable: '当前未检测到可用的 Orca Bot，请先在 Orca 中创建至少一个 Bot。',
  shortenedNote: '（回复过长已截断，请在 Orca 中查看完整内容）',
  tableMarker: (n) => `📊 **表格 ${n}**（见下方图片）`,
  tableCaption: (n) => `表格 ${n}`,
  orcaUserMessageHeader: (botName) => `🗣️ **你在 Orca (${botName}) 发送：**`,
  help: ({ botName, orcaChatId, syncOn, commands }) =>
    [
      `当前连接 Bot：${botName || '(未检测到)'}`,
      ...(orcaChatId === undefined ? [] : [`当前会话：${orcaChatId || '(新会话，将在下一条消息创建)'}`]),
      ...(syncOn === undefined ? [] : [`双向同步 (Orca -> TG)：${zhOnOff(syncOn)}`]),
      '',
      '可用指令：',
      ...allowedLines(
        [
          '/bots - 列出 Orca Bot（本 Telegram 机器人只与其中一个对话）',
          '/chats - 查看并点击绑定历史会话',
          '/home - 绑定当前 Bot 的 Home Chat',
          '/new - 清空当前上下文，开启新对话',
          '/bind <chatId> - 绑定到指定的 Orca 会话',
          '/rename <新标题> - 重命名当前绑定的会话',
          '/sync [on|off] - 开关 Orca 端消息双向同步',
          '/automations - 查看并触发自动化任务',
          '/run <id> - 立即执行指定自动化任务',
          '/status - 查看连接与会话状态'
        ],
        commands
      )
    ].join('\n'),
  status: ({ botUsername, botName, orcaChatId, syncOn, pollStatus }) =>
    [
      `Telegram Bot: ${botUsername ? `@${botUsername}` : '未知'}`,
      `目标 Orca Bot: ${botName}`,
      ...(orcaChatId === undefined ? [] : [`绑定会话 ID: ${orcaChatId || '(未创建，发消息自动新建)'}`]),
      ...(syncOn === undefined ? [] : [`双向同步 (Orca -> TG): ${zhOnOff(syncOn)}`]),
      `轮询状态: ${pollStatus}`
    ].join('\n'),
  currentSuffix: ' (当前)',
  linkedSuffix: ' (已绑定)',
  noBotsFound: '未检测到 Orca Bot。',
  botPinned: (botName) =>
    `这个 Telegram 机器人已绑定到 ${botName || '第一个 Orca Bot'}。如需更换，请联系所有者在 Orca 中修改。`,
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
  runFailed: (detail) => `触发失败：${detail}`,
  groupNotice: {
    new: (who) => `${who} 开始了新会话`,
    home: (who) => `${who} 切换到了 Home Chat`,
    bind: (who) => `${who} 切换到了另一个 Orca 会话`,
    rename: (who) => `${who} 重命名了 Orca 会话`,
    sync: (who, on) => `${who} ${on ? '开启' : '关闭'}了 Orca 同步`,
    run: (who, automation) => `${who} 运行了 ${automation}`
  }
}

const CATALOG: Record<ReplyLanguage, Messages> = {
  en,
  'pt-BR': ptBR,
  es,
  'zh-CN': zhCN
}

export function normalizeLanguage(value: unknown): ReplyLanguage {
  return REPLY_LANGUAGES.find((lang) => lang === value) ?? 'en'
}

export function normalizeLanguageSetting(value: unknown): ReplyLanguageSetting {
  return value === 'auto' ? 'auto' : normalizeLanguage(value)
}

/** The catalog language for a Telegram user's `language_code` (IETF tag, e.g. `pt-br`, `es`, `zh-hans`); English otherwise. */
export function languageFromTelegramCode(code: string | undefined): ReplyLanguage {
  const base = (code ?? '').toLowerCase().split(/[-_]/)[0]
  if (base === 'pt') return 'pt-BR'
  if (base === 'es') return 'es'
  if (base === 'zh') return 'zh-CN'
  return 'en'
}

export function t(lang: ReplyLanguage): Messages {
  return CATALOG[lang]
}
