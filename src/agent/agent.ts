import type AuditorPlugin from '../main';
import { RoleAgent } from '../swarm/roleAgent';
import { buildSystemPrompt } from './prompt';
import { AGENT_TOOLS } from './tools';
import type { AgentHost } from './types';

/**
 * The interactive chat's agent — a thin, behavior-preserving wrapper over `RoleAgent` (the
 * generalized loop the agent swarm's specialist roles also run on) configured with the full tool
 * registry, the standard system prompt, and the plugin's single shared, unscoped memory store.
 * Every chat tab owns one of these (distinct `agentId`), but they all read and write that same
 * memory — so what one tab learns, the others can recall.
 */
export class ChatAgent {
	private inner: RoleAgent;

	constructor(plugin: AuditorPlugin, agentId = 'chat') {
		this.inner = new RoleAgent(plugin, {
			agentId,
			tools: AGENT_TOOLS,
			systemPrompt: buildSystemPrompt(),
			memory: plugin.agentMemory,
		});
	}

	get isRunning(): boolean {
		return this.inner.isRunning;
	}

	getSummary(): string {
		return this.inner.getSummary();
	}

	reset(): void {
		this.inner.reset();
	}

	stop(): void {
		this.inner.stop();
	}

	steer(text: string): void {
		this.inner.steer(text);
	}

	async run(userText: string, host: AgentHost, isBurnModeEnabled: () => boolean = () => false): Promise<void> {
		await this.inner.run(userText, host, isBurnModeEnabled);
	}
}
