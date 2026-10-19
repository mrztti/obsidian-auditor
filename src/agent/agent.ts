import type AuditorPlugin from '../main';
import { RoleAgent } from '../swarm/roleAgent';
import { buildSystemPrompt } from './prompt';
import { AGENT_TOOLS } from './tools';
import type { AgentHost } from './types';

/**
 * The interactive chat's agent — a thin, behavior-preserving wrapper over `RoleAgent` (the
 * generalized loop the agent swarm's specialist roles also run on) configured with the full tool
 * registry, the standard system prompt, and the plugin's single shared, unscoped memory store
 * (exactly what this used to be before the loop was extracted to be reusable).
 */
export class ChatAgent {
	private inner: RoleAgent;

	constructor(plugin: AuditorPlugin) {
		this.inner = new RoleAgent(plugin, {
			agentId: 'chat',
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
