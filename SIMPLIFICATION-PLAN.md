# Plano de Simplificação

Estado: **Fase 1 — Pendente**

## Fases

| Fase | Descrição | Estado |
|------|-----------|--------|
| 1 | Remover suporte Daytona | Pendente |
| 2 | Remover electric-agent e funcionalidades não usadas pelo Claude Code | Pendente |
| 3 | Melhoramentos de interface e simplificação da arquitetura | Pendente |
| 4 | Modo de interação nativo com Claude Code | Pendente |

---

## Fase 1 — Remover suporte Daytona

Daytona nunca foi usado em produção. Remover todo o código, dependências e documentação.

### Ficheiros a eliminar

| Ficheiro | Descrição |
|----------|-----------|
| `packages/studio/src/sandbox/daytona.ts` | DaytonaSandboxProvider |
| `packages/studio/src/sandbox/daytona-registry.ts` | Registry + snapshot management |
| `packages/studio/src/sandbox/daytona-push.ts` | CLI push script |
| `packages/studio/src/bridge/daytona.ts` | DaytonaSessionBridge |
| `packages/agent/tests/e2e-daytona.test.ts` | Testes e2e Daytona |
| `scripts/check-sandbox.ts` | Script de debug Daytona |

### Ficheiros a editar

| Ficheiro | Alteração |
|----------|-----------|
| `packages/studio/src/sandbox/types.ts` | Remover `"daytona"` do union `SandboxRuntime` |
| `packages/studio/src/sandbox/index.ts` | Remover re-export `DaytonaSandboxProvider` |
| `packages/studio/src/bridge/index.ts` | Remover re-export `DaytonaSessionBridge` |
| `packages/studio/src/server.ts` | Remover imports Daytona, bloco bridge Daytona |
| `packages/studio/src/bridge/claude-md-generator.ts` | Remover `"daytona"` do union, simplificar condicionais |
| `packages/studio/tests/sandbox.test.ts` | Remover testes Daytona |
| `packages/protocol/src/events.ts` | Remover `"daytona"` do union `runtime` |
| `packages/agent/src/cli/serve.ts` | Remover imports Daytona, bloco runtime selection, bridge mode |
| `packages/studio/package.json` | Remover deps `@daytonaio/api-client`, `@daytonaio/sdk` |
| `packages/agent/package.json` | Remover dep `@daytonaio/sdk`, script `test:daytona` |
| `package.json` (root) | Remover script `push:sandbox:daytona` |
| `.env.example` | Remover variáveis `DAYTONA_*` |
| `CLAUDE.md` | Remover toda documentação Daytona |

---

## Fase 2 — Remover electric-agent e funcionalidades não usadas pelo Claude Code

O objetivo é manter apenas o que o Claude Code usa: studio (UI + server + bridges Claude Code) e protocol.

### Package `@electric-agent/agent` — ELIMINAR INTEGRALMENTE

Todo o package `packages/agent/` será removido. Inclui:

| Módulo | Ficheiros | Descrição |
|--------|-----------|-----------|
| CLI | `src/index.ts`, `src/cli/headless.ts`, `src/cli/serve.ts` | Comandos `headless`, `serve`, `scaffold` |
| Orchestrator | `src/engine/orchestrator.ts` | State machine: clarify → plan → scaffold → code |
| Message Parser | `src/engine/message-parser.ts` | SDK message → EngineEvent |
| Stream Adapter | `src/engine/stream-adapter.ts` | OrchestratorCallbacks para streams |
| Headless Adapter | `src/engine/headless-adapter.ts` | OrchestratorCallbacks para NDJSON |
| Clarifier | `src/agents/clarifier.ts` | Avaliação de descrição + perguntas |
| Planner | `src/agents/planner.ts` | Geração de PLAN.md (Sonnet, 10 turns) |
| Coder | `src/agents/coder.ts` | Implementação (Sonnet, 200 turns, $25) |
| Prompts | `src/agents/prompts.ts` | System prompts dos agentes |
| Build Tool | `src/tools/build.ts` | MCP tool: pnpm build/check/test |
| Playbook Tools | `src/tools/playbook.ts` | MCP tools: list/read playbooks |
| Tool Server | `src/tools/server.ts` | MCP server factory |
| Guardrail Hooks | `src/hooks/*.ts` (7 ficheiros) | write-protection, import-validation, etc. |
| Scaffold | `src/scaffold/index.ts` | Criação de projetos KPB + Electric |
| Working Memory | `src/working-memory/*.ts` | session.ts, errors.ts |
| Progress | `src/progress/reporter.ts` | CLI progress output |
| Git Module | `src/git/index.ts` | Git operations via `gh` CLI |
| Playbooks | `playbooks/` | electric-app-guardrails |
| Template | `template/` | Overlay files para scaffold |
| Testes | `tests/` | scaffold, bridge, e2e tests |

### Package `@electric-agent/studio` — Funcionalidades a remover

#### Bridges que só o electric-agent usa

| Ficheiro | Descrição |
|----------|-----------|
| `src/bridge/docker-stdio.ts` | DockerStdioBridge (stdin/stdout para electric-agent headless) |
| `src/bridge/sprites.ts` | SpritesStdioBridge (idem para Sprites) |

Bridges que ficam:
- `src/bridge/hosted.ts` — HostedStreamBridge (Durable Streams, usado por ambos)
- `src/bridge/claude-code-docker.ts` — ClaudeCodeDockerBridge
- `src/bridge/claude-code-sprites.ts` — ClaudeCodeSpritesBridge

#### Server routes que só o electric-agent usa

| Route | Descrição |
|-------|-----------|
| `POST /api/provision-electric` | Claim API provisioning (infra_config gate) |
| Git ops em `POST /api/sessions/:id/iterate` | Bloco `git:*` commands |
| Lógica de `agentMode: "electric-agent"` | Toggle e branching no server |

#### Funcionalidades do server a remover/simplificar

| Funcionalidade | Descrição |
|----------------|-----------|
| `electric-api.ts` | Claim API provisioning (só electric-agent usa) |
| `git.ts` | GitHub list fns (usadas pela infra_config gate) |
| Gate `infra_config` | Configuração de infra (local/cloud/claim) — só electric-agent |
| Gate `clarification` | Perguntas de clarificação — só electric-agent |
| Gate `plan_ready` / `revision` | Aprovação de plano — só electric-agent |
| `agentMode` toggle | Distinção electric-agent vs claude-code |
| `bridgeMode` selection | Lógica stdio vs stream vs claude-code |

#### UI components a remover/simplificar

| Componente | Descrição |
|------------|-----------|
| `GatePrompt.tsx` — secções `infra_config` | Config gate com repo picker, DB mode |
| `GatePrompt.tsx` — secções `clarification` | Perguntas do clarifier |
| `GatePrompt.tsx` — secções `plan_ready` | Approve/revise/cancel plan |
| `RepoPickerModal.tsx` | GitHub repo + branch selector (infra_config) |
| `Settings.tsx` — agent mode toggle | Toggle electric-agent / claude-code |
| Cost tracking no header | `cost_update` events (SDK-only) |

#### Event types a remover do protocol

| Event | Descrição |
|-------|-----------|
| `clarification_needed` | Gate do clarifier |
| `plan_ready` | Gate do planner |
| `cost_update` | Custo acumulado do SDK |
| `scaffold_start` / `scaffold_complete` | Eventos de scaffold |

### Dependências a remover

| Package | De onde |
|---------|--------|
| `@anthropic-ai/sdk` | agent |
| `@anthropic-ai/claude-code` | agent |
| `commander` | agent |
| Todas deps em `packages/agent/package.json` | agent (package inteiro removido) |

### Workspace config a atualizar

| Ficheiro | Alteração |
|----------|-----------|
| `pnpm-workspace.yaml` | Remover `packages/agent` |
| `package.json` (root) | Remover scripts referentes ao agent |
| `tsconfig.json` references | Remover referência ao agent |
| `CLAUDE.md` | Atualizar toda documentação |
| `ARCHITECTURE.md` | Atualizar ou reescrever |

---

## Fase 3 — Melhoramentos de interface e simplificação da arquitetura (A DISCUTIR)

Após remover Daytona e o electric-agent, a arquitetura resultante será:

```
packages/
├── protocol/          # EngineEvent types (simplificado)
└── studio/            # Server + UI + bridges Claude Code
    ├── src/
    │   ├── server.ts           # API server (simplificado)
    │   ├── gate.ts             # Gates (só ask_user_question, continue)
    │   ├── sessions.ts         # Session index
    │   ├── streams.ts          # Durable Streams config
    │   ├── sandbox/
    │   │   ├── types.ts        # SandboxProvider interface
    │   │   ├── docker.ts       # DockerSandboxProvider
    │   │   ├── sprites.ts      # SpritesSandboxProvider
    │   │   └── index.ts
    │   └── bridge/
    │       ├── types.ts        # SessionBridge interface
    │       ├── hosted.ts       # HostedStreamBridge
    │       ├── claude-code-docker.ts
    │       ├── claude-code-sprites.ts
    │       ├── stream-json-parser.ts
    │       └── index.ts
    └── client/                 # React SPA (simplificada)
```

### Questões para discussão

1. **Monorepo vs single package**: Com só protocol + studio, faz sentido manter monorepo? Ou fundir protocol no studio?
2. **Simplificação de bridges**: ClaudeCodeDockerBridge e ClaudeCodeSpritesBridge partilham ~90% do código. Extrair base class?
3. **Simplificação do server**: server.ts tem ~2100 linhas. Dividir em route modules?
4. **Shared sessions**: Funcionalidade de colaboração — está a ser usada? Manter?
5. **Gate system**: Com só `ask_user_question` e `continue`, simplificar a abstração?
6. **Sandbox provider interface**: Simplificar agora que não há Daytona?
7. **CLAUDE.md generation**: Simplificar `claude-md-generator.ts` removendo lógica electric-agent?

---

## Fase 4 — Modo de interação nativo com Claude Code (A DISCUTIR)

### Situação atual

Claude Code é executado em **one-shot** (`-p`) em ambas configurações (Docker e Sprites):
- Cada interação spawna um novo processo
- `iterate` mata o processo anterior e re-spawna com `--resume`
- Gates (`AskUserQuestion`) bloqueiam o processo e enviam resposta via stdin

### Problemas com o approach atual

1. **Kill + respawn no iterate**: Ineficiente, perde estado do processo
2. **One-shot com stdin gates**: Tensão conceptual — `-p` é one-shot mas aceita input a meio
3. **Duas bridges quase idênticas**: Docker e Sprites duplicam lógica
4. **Stream-json parsing frágil**: Parser custom para traduzir formato Claude Code → EngineEvent

### Alternativas a explorar

1. **Modo conversacional**: Claude Code sem `-p`, usando stdin para enviar mensagens continuamente. Um único processo de longa duração por sessão.
2. **SDK direto**: Usar `@anthropic-ai/claude-code` SDK em vez de spawnar CLI. Mais controlo, menos parsing.
3. **Hook-only mode**: Remover bridges Claude Code, usar apenas o hook forwarding (como funciona para sessões locais).

### Questões para discussão

1. O SDK do Claude Code suporta modo conversacional nativo?
2. Quais são as limitações do hook-only mode para sandboxes?
3. Podemos eliminar o stream-json parser se usarmos o SDK?
