export type AgentId = 'orchestrator' | 'coder' | 'reviewer';

export type AgentProfile = {
  id: AgentId;
  name: string;
  role: string;
  tagline: string;
  system?: string;
  accent: string;
};

export type VoiceProfile = {
  elevenVoiceId: string;
  elevenLabel: string;
  pitch: number;
  rate: number;
};

export type Bootstrap = {
  app: string;
  tagline: string;
  auth: {
    method: string;
    otpDigits: number;
    otpMinutes: number;
    pinDigits: number;
    senderName: string;
    senderAddress: string;
    mailConfigured: boolean;
  };
  providers: ProviderPreset[];
  agents: AgentProfile[];
  themes: Array<{ id: string; label: string }>;
};

export type ProviderPreset = {
  id: string;
  label: string;
  kind: 'llm' | 'tts' | 'github';
  baseUrl: string;
  defaultModel?: string;
  docs: string;
  keyHint: string;
  local?: boolean;
  note?: string;
};

export type Me = {
  sub: string;
  provider: 'email';
  tag: string;
  displayName: string | null;
  email: string | null;
  picture: string | null;
  theme: string;
  pinEnabled: boolean;
  voiceProfile: Partial<Record<AgentId, VoiceProfile>> | null;
  createdAt: string;
};

export const THEMES_25: Array<{ id: string; label: string }> = [
  { id: 'classic-dark', label: 'Classic Dark' },
  { id: 'stranger-things', label: 'Stranger Things' },
  { id: 'from-series', label: 'From Series' },
  { id: 'arc-reactor', label: 'Arc Reactor' },
  { id: 'cyberpunk', label: 'Cyberpunk' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'monokai', label: 'Monokai' },
  { id: 'nord', label: 'Nord' },
  { id: 'gruvbox', label: 'Gruvbox' },
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'one-dark-pro', label: 'One Dark Pro' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { id: 'synthwave-84', label: 'Synthwave 84' },
  { id: 'matrix-green', label: 'Matrix Green' },
  { id: 'solarized-dark', label: 'Solarized Dark' },
  { id: 'github-dark', label: 'GitHub Dark' },
  { id: 'midnight-blue', label: 'Midnight Blue' },
  { id: 'emerald-abyss', label: 'Emerald Abyss' },
  { id: 'sunset-vibes', label: 'Sunset Vibes' },
  { id: 'rose-pine', label: 'Rose Pine' },
  { id: 'palenight', label: 'Palenight' },
  { id: 'mind-flayer-void', label: 'Mind Flayer Void' },
  { id: 'vecna-curse', label: 'Vecna Curse' },
  { id: 'obsidian-gold', label: 'Obsidian Gold' },
  { id: 'titanium-glass', label: 'Titanium Glass' },
];

export type Connector = {
  id: string;
  provider: string;
  providerLabel: string;
  name: string;
  baseUrl: string | null;
  model: string | null;
  isDefault: boolean;
  isVecna?: boolean;
  enabled: boolean;
  kind: 'llm' | 'tts' | 'github';
  hasKey: boolean;
  keyHint: string;
  createdAt: string;
};

export type Project = {
  id: string;
  name: string;
  description: string | null;
  repo: string | null;
  branch: string;
  aiCount: number;
  createdAt: string;
};

export const AI_FIELDS = [
  'unassigned',
  'frontend',
  'backend',
  'fullstack',
  'review',
  'testing',
  'docs',
  'devops',
  'research',
  'design',
] as const;

export type ProjectAi = {
  id: string;
  slot: number;
  label: string;
  field: string;
  connectorId: string | null;
  connector: {
    id: string;
    name: string | null;
    providerLabel: string | null;
    model: string | null;
    online: boolean;
  } | null;
};

export type PoolMember = { slot: number; label: string; field: string; online: boolean };

export type VecnaStatus = {
  configured: boolean;
  model: string | null;
  provider: string | null;
  name: string;
  hasAnyKey: boolean;
};

export type Attachment = { kind: 'image' | 'text'; name: string; mime?: string; data: string };

export type FieldEntry = {
  handle: string;
  title: string;
  description: string;
  appUrl: string | null;
  authorTag: string;
  tags: string[];
  stars: number;
  hasApp: boolean;
  html?: string | null;
  owned?: boolean;
  createdAt: string;
  cerebroUrl: string;
};

export type GhRepo = { full_name: string; name: string; default_branch: string; private: boolean };
export type GhTreeEntry = { path: string; type: 'blob' | 'tree'; size?: number };
export type GhStatus = { connected: boolean; login?: string; error?: string; defaultRepo: string; defaultBranch: string };

export type ChatSummary = {
  id: string;
  title: string;
  mode: string;
  locked: boolean;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TabId = 'vecna' | 'hellfire' | 'manager' | 'projects' | 'field' | 'cerebro';

export type ChatMessage = {
  id?: string;
  role: string;
  agent?: string | null;
  content: string;
  meta?: string | null;
  created_at?: string;
};

export type CallEntry = { speaker: string; text: string };

export type MailItem = {
  id: string;
  to_email: string;
  from_email: string;
  subject: string;
  html: string;
  body_text: string;
  status: string;
  provider: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
};
