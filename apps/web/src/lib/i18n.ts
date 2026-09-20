import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

/**
 * Thai is the default because the pilot's customers are Thai salon owners.
 * English exists from the start so adding a third language later is translation work
 * rather than refactoring.
 */

const th = {
  app: { name: 'ระบบแชท AI', signOut: 'ออกจากระบบ' },
  nav: { inbox: 'กล่องข้อความ', simulator: 'ทดลองแชท', settings: 'ตั้งค่า' },
  auth: {
    title: 'เข้าสู่ระบบ',
    email: 'อีเมล',
    password: 'รหัสผ่าน',
    signIn: 'เข้าสู่ระบบ',
    failed: 'เข้าสู่ระบบไม่สำเร็จ',
  },
  inbox: {
    title: 'กล่องข้อความ',
    empty: 'ยังไม่มีบทสนทนา',
    waiting: 'รอเจ้าหน้าที่',
    filters: { all: 'ทั้งหมด', open: 'เปิดอยู่', resolved: 'จบแล้ว', unassigned: 'ยังไม่มีผู้รับ' },
    searchPlaceholder: 'ค้นหา',
  },
  modes: {
    ai: 'AI ตอบ',
    ai_supervised: 'AI ร่าง',
    human: 'เจ้าหน้าที่',
    waiting_human: 'รอเจ้าหน้าที่',
  },
  conversation: {
    takeOver: 'รับช่วงต่อ',
    returnToAi: 'ส่งคืน AI',
    returnNote: 'ข้อความถึง AI (ไม่บังคับ)',
    placeholder: 'พิมพ์ข้อความ...',
    send: 'ส่ง',
    internalNote: 'บันทึกภายใน',
    addNote: 'เพิ่มบันทึก',
    resolve: 'ปิดบทสนทนา',
    reopen: 'เปิดอีกครั้ง',
    noMessages: 'ยังไม่มีข้อความ',
    handoffReason: 'เหตุผลที่ส่งต่อ',
    selectPrompt: 'เลือกบทสนทนาเพื่อเริ่ม',
  },
  sidebar: {
    suggestion: 'ข้อความที่ AI แนะนำ',
    insert: 'ใส่ในช่องพิมพ์',
    insertAndSend: 'ใส่และส่ง',
    discard: 'ไม่ใช้',
    noSuggestion: 'ยังไม่มีคำแนะนำ',
    customer: 'ข้อมูลลูกค้า',
    summary: 'สรุปบทสนทนาที่ผ่านมา',
    cost: 'ค่าใช้จ่าย',
    lastTrace: 'การทำงานล่าสุดของ AI',
    fallbackUsed: 'ใช้ผู้ให้บริการสำรอง',
    viewTrace: 'ดูรายละเอียด',
  },
  simulator: {
    title: 'ทดลองแชท',
    description: 'ส่งข้อความเหมือนเป็นลูกค้า เพื่อทดสอบ AI โดยไม่ต้องใช้ LINE หรือ Facebook',
    customerName: 'ชื่อลูกค้า',
    customerId: 'รหัสลูกค้า',
    send: 'ส่งข้อความ',
    noChannel: 'ยังไม่มีช่องทางทดสอบ',
  },
  settings: {
    title: 'ตั้งค่า',
    workspace: 'พื้นที่ทำงาน',
    providers: 'ผู้ให้บริการ AI',
    taskSlots: 'รุ่นที่ใช้ในแต่ละงาน',
    channels: 'ช่องทาง',
    members: 'ผู้ใช้งาน',
    persona: 'บุคลิกและคำสั่งของ AI',
    defaultMode: 'โหมดเริ่มต้น',
    defaultLanguage: 'ภาษาเริ่มต้น',
    redaction: 'การปกปิดข้อมูล',
    cardNumbers: 'เลขบัตรเครดิต',
    thaiNationalId: 'เลขบัตรประชาชน',
    save: 'บันทึก',
    saved: 'บันทึกแล้ว',
    addProvider: 'เพิ่มผู้ให้บริการ',
    name: 'ชื่อ',
    baseUrl: 'ที่อยู่ API',
    apiKey: 'คีย์ API',
    keySet: 'ตั้งค่าคีย์แล้ว',
    primary: 'หลัก',
    fallback: 'สำรอง',
    model: 'รุ่น',
    none: 'ไม่ใช้',
    webhookUrl: 'ที่อยู่ Webhook',
  },
  common: {
    loading: 'กำลังโหลด...',
    error: 'เกิดข้อผิดพลาด',
    retry: 'ลองใหม่',
    cancel: 'ยกเลิก',
    close: 'ปิด',
    you: 'คุณ',
    ai: 'AI',
    customer: 'ลูกค้า',
    system: 'ระบบ',
  },
}

const en: typeof th = {
  app: { name: 'AI Chat Desk', signOut: 'Sign out' },
  nav: { inbox: 'Inbox', simulator: 'Simulator', settings: 'Settings' },
  auth: {
    title: 'Sign in',
    email: 'Email',
    password: 'Password',
    signIn: 'Sign in',
    failed: 'Sign in failed',
  },
  inbox: {
    title: 'Inbox',
    empty: 'No conversations yet',
    waiting: 'Waiting for a human',
    filters: { all: 'All', open: 'Open', resolved: 'Resolved', unassigned: 'Unassigned' },
    searchPlaceholder: 'Search',
  },
  modes: {
    ai: 'AI',
    ai_supervised: 'AI drafts',
    human: 'Human',
    waiting_human: 'Waiting',
  },
  conversation: {
    takeOver: 'Take over',
    returnToAi: 'Return to AI',
    returnNote: 'Note for the AI (optional)',
    placeholder: 'Write a message...',
    send: 'Send',
    internalNote: 'Internal note',
    addNote: 'Add note',
    resolve: 'Resolve',
    reopen: 'Reopen',
    noMessages: 'No messages yet',
    handoffReason: 'Handoff reason',
    selectPrompt: 'Choose a conversation to start',
  },
  sidebar: {
    suggestion: 'Suggested reply',
    insert: 'Insert',
    insertAndSend: 'Insert and send',
    discard: 'Discard',
    noSuggestion: 'No suggestion yet',
    customer: 'Customer',
    summary: 'Summary of past conversations',
    cost: 'Cost',
    lastTrace: 'Last AI run',
    fallbackUsed: 'Fallback provider used',
    viewTrace: 'View details',
  },
  simulator: {
    title: 'Simulator',
    description: 'Send messages as a customer to exercise the AI without LINE or Facebook.',
    customerName: 'Customer name',
    customerId: 'Customer id',
    send: 'Send message',
    noChannel: 'No test channel configured',
  },
  settings: {
    title: 'Settings',
    workspace: 'Workspace',
    providers: 'AI providers',
    taskSlots: 'Model per task',
    channels: 'Channels',
    members: 'People',
    persona: 'AI persona and instructions',
    defaultMode: 'Default mode',
    defaultLanguage: 'Default language',
    redaction: 'Redaction',
    cardNumbers: 'Card numbers',
    thaiNationalId: 'Thai national ID',
    save: 'Save',
    saved: 'Saved',
    addProvider: 'Add provider',
    name: 'Name',
    baseUrl: 'Base URL',
    apiKey: 'API key',
    keySet: 'Key is set',
    primary: 'Primary',
    fallback: 'Fallback',
    model: 'Model',
    none: 'None',
    webhookUrl: 'Webhook URL',
  },
  common: {
    loading: 'Loading...',
    error: 'Something went wrong',
    retry: 'Try again',
    cancel: 'Cancel',
    close: 'Close',
    you: 'You',
    ai: 'AI',
    customer: 'Customer',
    system: 'System',
  },
}

const STORAGE_KEY = 'ci.language'

function initialLanguage(): 'th' | 'en' {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'th' || stored === 'en') return stored
  } catch {
    // Private browsing or blocked storage: fall through to the default.
  }
  return 'th'
}

void i18next.use(initReactI18next).init({
  resources: { th: { translation: th }, en: { translation: en } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export function setLanguage(language: 'th' | 'en'): void {
  void i18next.changeLanguage(language)
  document.documentElement.lang = language
  try {
    localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // Not being able to remember the choice is not worth failing over.
  }
}

document.documentElement.lang = i18next.language

export default i18next
