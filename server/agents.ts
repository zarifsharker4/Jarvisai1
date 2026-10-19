import {
  demoStream,
  llmStream,
  type ChatMessage,
  type ResolvedEngine,
} from './providers';

/**
 * The three collaborating agents. Personas are used for the pipeline
 * (Orchestrator -> Coder -> Reviewer), the AI-to-AI discussion space and
 * the Call Mind Flayer voice room.
 */
export type AgentId = 'orchestrator' | 'coder' | 'reviewer';

export type AgentProfile = {
  id: AgentId;
  name: string;
  role: string;
  tagline: string;
  system: string;
  accent: string;
};

export const AGENTS: Record<AgentId, AgentProfile> = {
  orchestrator: {
    id: 'orchestrator',
    name: 'Orchestrator',
    role: 'Planner',
    tagline: 'Breaks work into steps and delegates',
    accent: '#7c8cff',
    system:
      'You are Orchestrator, lead of the Mind Flayer team. You never write full implementations; you decompose requests into precise, testable steps, state assumptions, and hand off to Coder and Reviewer. Be concise and concrete. Use short markdown lists.',
  },
  coder: {
    id: 'coder',
    name: 'Coder',
    role: 'Implementer',
    tagline: 'Writes production-ready code',
    accent: '#3ddc97',
    system:
      'You are Coder, the implementation specialist on the Mind Flayer team. You write complete, runnable, idiomatic code with guard clauses and clear types. Prefer complete code blocks over pseudocode. Keep prose to a minimum around the code.',
  },
  reviewer: {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'Quality gate',
    tagline: 'Audits correctness, security, tests',
    accent: '#f2b45c',
    system:
      'You are Reviewer, the quality gate on the Mind Flayer team. You audit code for correctness, security, edge cases and missing tests. Start your verdict with a line: "**Review verdict: PASS**" or "**Review verdict: REVISE**" followed by specific findings.',
  },
};

export const AGENT_ORDER: AgentId[] = ['orchestrator', 'coder', 'reviewer'];

export function isAgentId(value: unknown): value is AgentId {
  return value === 'orchestrator' || value === 'coder' || value === 'reviewer';
}

export type Emit = (event: string, data: Record<string, unknown>) => void | Promise<void>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamAgent(
  engine: ResolvedEngine,
  agent: AgentId,
  messages: ChatMessage[],
  emit: Emit,
): Promise<string> {
  const profile = AGENTS[agent];
  let assembled = '';
  const onToken = async (chunk: string) => {
    assembled += chunk;
    await emit('token', { agent, name: profile.name, text: chunk });
  };
  if (engine.engine === 'demo') {
    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    await demoStream(agent, prompt, onToken);
  } else {
    await llmStream(engine.client, [{ role: 'system', content: profile.system }, ...messages], onToken);
  }
  return assembled;
}

/**
 * 3-agent collaborative pipeline: Orchestrator plans, Coder implements,
 * Reviewer audits. A REVISE verdict triggers one bounded revision round.
 */
export async function runPipeline(
  engine: ResolvedEngine,
  request: string,
  emit: Emit,
): Promise<void> {
  await emit('stage', { agent: 'orchestrator', status: 'start' });
  const plan = await streamAgent(
    engine,
    'orchestrator',
    [{ role: 'user', content: `Task:\n${request}\n\nProduce the implementation plan.` }],
    emit,
  );
  await emit('stage', { agent: 'orchestrator', status: 'end', text: plan });

  await emit('stage', { agent: 'coder', status: 'start' });
  const code = await streamAgent(
    engine,
    'coder',
    [
      { role: 'user', content: `Orchestrator's plan:\n${plan}\n\nImplement it fully now.` },
    ],
    emit,
  );
  await emit('stage', { agent: 'coder', status: 'end', text: code });

  await emit('stage', { agent: 'reviewer', status: 'start' });
  let review = await streamAgent(
    engine,
    'reviewer',
    [{ role: 'user', content: `Plan:\n${plan}\n\nImplementation:\n${code}\n\nReview it.` }],
    emit,
  );
  await emit('stage', { agent: 'reviewer', status: 'end', text: review });

  if (/REVISE/i.test(review)) {
    await emit('stage', { agent: 'coder', status: 'start', round: 2 });
    const revision = await streamAgent(
      engine,
      'coder',
      [
        {
          role: 'user',
          content: `Reviewer flagged issues in your implementation:\n${review}\n\nOriginal implementation:\n${code}\n\nProduce the corrected implementation.`,
        },
      ],
      emit,
    );
    await emit('stage', { agent: 'coder', status: 'end', round: 2, text: revision });
    await emit('stage', { agent: 'reviewer', status: 'start', round: 2 });
    review = await streamAgent(
      engine,
      'reviewer',
      [{ role: 'user', content: `Revised implementation:\n${revision}\n\nRe-review it.` }],
      emit,
    );
    await emit('stage', { agent: 'reviewer', status: 'end', round: 2, text: review });
  }
}

/**
 * Live AI-to-AI discussion: the three agents talk to each other about the
 * topic for `rounds` turns, each seeing the transcript so far.
 */
export async function runDiscussion(
  engine: ResolvedEngine,
  topic: string,
  rounds: number,
  emit: Emit,
  interjection?: string,
): Promise<void> {
  const transcript: string[] = [];
  const total = Math.max(2, Math.min(12, rounds));

  for (let i = 0; i < total; i++) {
    const agent = AGENT_ORDER[i % AGENT_ORDER.length];
    const history: ChatMessage[] = [
      {
        role: 'user',
        content: [
          `Discussion topic: ${topic}`,
          interjection && i === 1 ? `The human added: ${interjection}` : '',
          transcript.length ? `Transcript so far:\n${transcript.join('\n\n')}` : 'The discussion has not started yet.',
          '',
          `You are ${AGENTS[agent].name}. Reply in 2-4 sentences, advance the discussion, and address the previous speaker by name when replying. Do not repeat what has already been said.`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];
    await emit('turn', { agent, name: AGENTS[agent].name, status: 'start' });
    const text = await streamAgent(engine, agent, history, emit);
    transcript.push(`${AGENTS[agent].name}: ${text}`);
    await emit('turn', { agent, name: AGENTS[agent].name, status: 'end', text });
    await sleep(120);
  }
  await emit('summary', { turns: transcript.length, transcript });
}

/**
 * Call Mind Flayer: routes the human's spoken/transcribed line to the right agent
 * (keyword routing, otherwise round-robin) and may add a short follow-up so
 * the call feels like a group conversation.
 */
export async function callTurn(
  engine: ResolvedEngine,
  history: Array<{ speaker: string; text: string }>,
  lastSpeaker: AgentId | 'you',
  emit: Emit,
): Promise<void> {
  const lastUser = [...history].reverse().find((h) => h.speaker === 'you');
  const line = lastUser?.text ?? 'Hello?';
  const lower = line.toLowerCase();

  // Score-based routing so "review this code for security issues" reaches the
  // Reviewer instead of whichever bucket happens to be checked first.
  const count = (pattern: RegExp) => (lower.match(pattern) ?? []).length;
  const scores: Record<AgentId, number> = {
    orchestrator: count(/\b(plan|plans|scope|start|first|should we|what next|orchestrat\w*|prioriti\w*|order)\b/g),
    coder: count(/\b(code|coding|codes|function|implement\w*|build|write|refactor\w*|script|api|feature|fix|debug)\b/g),
    reviewer: count(/\b(reviews?|tests?|testing|security|secure|vulnerab\w*|audit|audits|check|verify|quality|bugs?|safe|correctness)\b/g),
  };

  let responder: AgentId;
  const best = Math.max(scores.orchestrator, scores.coder, scores.reviewer);
  if (best === 0) {
    const idx = AGENT_ORDER.indexOf(lastSpeaker as AgentId);
    responder = AGENT_ORDER[(idx + 1) % AGENT_ORDER.length] ?? 'orchestrator';
  } else if (scores.reviewer >= scores.coder && scores.reviewer >= scores.orchestrator) {
    responder = 'reviewer';
  } else if (scores.coder >= scores.orchestrator) {
    responder = 'coder';
  } else {
    responder = 'orchestrator';
  }

  const context = history.slice(-12).map((h) => `${h.speaker}: ${h.text}`).join('\n');
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `Group voice call transcript:\n${context}\n\nYou are ${AGENTS[responder].name}. Answer the human in 1-2 short spoken sentences. No markdown, no lists — plain speech only.`,
    },
  ];

  await emit('turn', { agent: responder, name: AGENTS[responder].name, status: 'start' });
  const text = await streamAgent(engine, responder, messages, emit);
  await emit('turn', { agent: responder, name: AGENTS[responder].name, status: 'end', text });

  const wantsGroup =
    /\b(all|everyone|team|together|each of you|what do you (two|all)|discuss|debate)\b/.test(lower);
  if (wantsGroup) {
    for (const followUp of AGENT_ORDER.filter((a) => a !== responder)) {
      await emit('turn', { agent: followUp, name: AGENTS[followUp].name, status: 'start' });
      const reply = await streamAgent(
        engine,
        followUp,
        [
          {
            role: 'user',
            content: `Group voice call transcript:\n${context}\n${AGENTS[responder].name} just said: "${text}"\n\nYou are ${AGENTS[followUp].name}. Add one short spoken sentence with your own take. Plain speech only.`,
          },
        ],
        emit,
      );
      await emit('turn', { agent: followUp, name: AGENTS[followUp].name, status: 'end', text: reply });
    }
  }
}
