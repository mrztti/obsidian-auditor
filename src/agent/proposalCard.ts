import { setIcon } from 'obsidian';
import { diffWords } from './diff';
import type { ApplyOutcome, ApprovalDecision, DiffEntry, ReviewItem, ReviewProposal } from './types';

function optionLabel(opt: string): string {
	return opt === '-' ? 'N/A (-)' : opt || '(none)';
}

function fillDiff(box: HTMLElement, before: string, after: string): void {
	box.empty();
	if (!before.trim() && !after.trim()) {
		box.createSpan({ text: '(empty)', cls: 'auditor-diff-empty' });
		return;
	}
	for (const part of diffWords(before, after)) {
		if (part.type === 'same') box.appendText(part.text);
		else box.createSpan({ text: part.text, cls: part.type === 'add' ? 'auditor-diff-add' : 'auditor-diff-del' });
	}
}

/**
 * One field's before/after diff, plus — when `entry.edit` is set — an "Edit" toggle that swaps the
 * diff for a live input and writes every keystroke straight back into the underlying record via
 * `edit.set`, so a hand refinement here is exactly what gets saved: no separate "apply my edits"
 * step, the diff and the record are the same value shown two ways.
 */
function renderField(card: HTMLElement, entry: DiffEntry): void {
	const row = card.createDiv('auditor-proposal-field');
	const labelRow = row.createDiv('auditor-proposal-field-labelrow');
	labelRow.createDiv({ text: entry.label, cls: 'auditor-proposal-field-label' });
	const diffBox = row.createDiv('auditor-diff');

	const { edit } = entry;
	const original = entry.after;
	const currentText = (): string => (edit ? (edit.kind === 'boolean' ? (edit.get() ? 'yes' : 'no') : edit.get()) : entry.after);

	let editedBadge: HTMLElement | null = null;
	const refresh = () => {
		fillDiff(diffBox, entry.before, currentText());
		editedBadge?.toggleClass('auditor-agent-hidden', currentText() === original);
	};
	refresh();
	if (!edit) return;

	editedBadge = labelRow.createSpan({ text: 'Edited', cls: 'auditor-proposal-edited-badge auditor-agent-hidden' });
	const editToggle = labelRow.createEl('a', { text: 'Edit', cls: 'auditor-proposal-field-edit-toggle' });
	const resetLink = labelRow.createEl('a', { text: 'Reset', cls: 'auditor-proposal-field-reset auditor-agent-hidden' });

	let editWrap: HTMLElement | null = null;
	let syncInput: (() => void) | null = null;

	const openEditor = () => {
		diffBox.addClass('auditor-agent-hidden');
		editWrap = row.createDiv('auditor-proposal-edit');
		if (edit.kind === 'boolean') {
			const checkLabel = editWrap.createEl('label', { cls: 'auditor-checkbox-label' });
			const checkbox = checkLabel.createEl('input', { type: 'checkbox' });
			checkbox.checked = edit.get();
			checkLabel.createSpan({ text: 'Yes' });
			checkbox.addEventListener('change', () => { edit.set(checkbox.checked); refresh(); });
			syncInput = () => { checkbox.checked = edit.get(); };
		} else if (edit.kind === 'select') {
			const select = editWrap.createEl('select', { cls: 'auditor-proposal-edit-select' });
			for (const opt of edit.options) {
				const optionEl = select.createEl('option', { text: optionLabel(opt), value: opt });
				optionEl.selected = opt === edit.get();
			}
			select.addEventListener('change', () => { edit.set(select.value); refresh(); });
			syncInput = () => { select.value = edit.get(); };
		} else {
			const textarea = editWrap.createEl('textarea', { cls: 'auditor-proposal-edit-textarea' });
			textarea.value = edit.get();
			textarea.addEventListener('input', () => { edit.set(textarea.value); refresh(); });
			syncInput = () => { textarea.value = edit.get(); };
		}
		editToggle.setText('Done');
	};
	const closeEditor = () => {
		editWrap?.remove();
		editWrap = null;
		syncInput = null;
		diffBox.removeClass('auditor-agent-hidden');
		editToggle.setText('Edit');
	};

	editToggle.addEventListener('click', (e) => {
		e.preventDefault();
		if (editWrap) closeEditor(); else openEditor();
	});
	resetLink.addEventListener('click', (e) => {
		e.preventDefault();
		if (edit.kind === 'boolean') edit.set(original === 'yes');
		else edit.set(original);
		syncInput?.();
		refresh();
	});
}

function renderItem(parent: HTMLElement, item: ReviewItem): { checkbox: HTMLInputElement; badge: HTMLElement; link: HTMLElement | null } {
	const card = parent.createDiv('auditor-proposal-change');
	const head = card.createDiv('auditor-proposal-change-head');
	const label = head.createEl('label', { cls: 'auditor-proposal-check' });
	const checkbox = label.createEl('input', { type: 'checkbox' });
	checkbox.checked = true;
	label.createSpan({ text: item.title, cls: 'auditor-proposal-number' });
	if (item.subtitle) label.createSpan({ text: item.subtitle, cls: 'auditor-proposal-topic' });
	const { open } = item;
	let link: HTMLElement | null = null;
	if (open) {
		link = head.createEl('a', { text: open.label, cls: 'auditor-proposal-open' });
		link.addEventListener('click', (e) => {
			e.preventDefault();
			open.run();
		});
	}
	const badge = head.createSpan('auditor-proposal-badge');

	for (const entry of item.entries) renderField(card, entry);
	return { checkbox, badge, link };
}

export interface ProposalCardHandle {
	/** Locks the card and shows which changes were saved / failed. */
	showOutcomes(outcomes: ApplyOutcome[]): void;
	/** Locks the card without writing anything (rejected, or the run was stopped). */
	lock(text: string): void;
}

/** Renders the proposed control changes as per-control diffs with approve/reject controls; resolves `decide` once the user chooses. */
export function renderProposalCard(
	parent: HTMLElement,
	proposal: ReviewProposal,
	decide: (decision: ApprovalDecision) => void,
): ProposalCardHandle {
	const card = parent.createDiv(proposal.burn ? 'auditor-proposal auditor-burn-frame' : 'auditor-proposal');
	const header = card.createDiv('auditor-proposal-header');
	setIcon(header.createSpan('auditor-proposal-icon'), 'git-pull-request-draft');
	if (proposal.burn) {
		const burnIcon = header.createSpan({ cls: 'auditor-burn-icon' });
		burnIcon.setAttr('aria-label', 'Generated with Burn Mode (boosted model)');
	}
	const headingEl = header.createSpan({ text: proposal.heading, cls: 'auditor-proposal-heading' });
	if (proposal.summary) card.createEl('p', { text: proposal.summary, cls: 'auditor-proposal-summary' });

	const rows = proposal.items.map((item) => ({ item, ...renderItem(card, item) }));

	const footer = card.createDiv('auditor-proposal-footer');
	const feedback = footer.createEl('textarea', { cls: 'auditor-pipeline-textarea auditor-proposal-feedback' });
	feedback.rows = 2;
	feedback.placeholder = 'Optional: tell the agent what to change if you reject something…';
	const buttons = footer.createDiv('auditor-proposal-buttons');
	const applyBtn = buttons.createEl('button', { text: 'Apply selected', cls: 'mod-cta' });
	const rejectBtn = buttons.createEl('button', { text: 'Reject all' });

	/** Once decided, the card shrinks to one line per object (name, status, link) to cut clutter; "Show changes" brings the diffs back. */
	const collapse = (heading: string) => {
		headingEl.setText(heading);
		card.addClass('is-collapsed');
		const toggle = header.createEl('a', { text: 'Show changes', cls: 'auditor-proposal-toggle' });
		toggle.addEventListener('click', (e) => {
			e.preventDefault();
			card.toggleClass('is-expanded', !card.hasClass('is-expanded'));
			toggle.setText(card.hasClass('is-expanded') ? 'Hide changes' : 'Show changes');
		});
	};

	let settled = false;
	const lockInputs = () => {
		settled = true;
		for (const r of rows) r.checkbox.disabled = true;
		feedback.disabled = true;
		applyBtn.disabled = true;
		rejectBtn.disabled = true;
	};
	const submit = (approvedNumbers: string[]) => {
		if (settled) return;
		lockInputs();
		decide({
			approved: approvedNumbers,
			rejected: rows.map((r) => r.item.key).filter((n) => !approvedNumbers.includes(n)),
			feedback: feedback.value.trim(),
		});
	};
	const updateApplyLabel = () => {
		const n = rows.filter((r) => r.checkbox.checked).length;
		applyBtn.setText(n === rows.length ? 'Apply all' : `Apply ${n} selected`);
		applyBtn.disabled = n === 0;
	};
	for (const r of rows) r.checkbox.addEventListener('change', updateApplyLabel);
	updateApplyLabel();
	applyBtn.addEventListener('click', () => submit(rows.filter((r) => r.checkbox.checked).map((r) => r.item.key)));
	rejectBtn.addEventListener('click', () => submit([]));

	return {
		showOutcomes(outcomes) {
			const byNumber = new Map(outcomes.map((o) => [o.key, o]));
			for (const r of rows) {
				const outcome = byNumber.get(r.item.key);
				r.badge.empty();
				if (!outcome) {
					r.badge.setText('Not applied');
					r.badge.addClass('is-rejected');
					r.link?.addClass('auditor-agent-hidden');
				} else if (outcome.ok) {
					r.badge.setText('Saved');
					r.badge.addClass('is-saved');
				} else {
					r.badge.setText('Failed');
					r.badge.addClass('is-failed');
					r.badge.setAttr('aria-label', outcome.error ?? '');
					r.link?.addClass('auditor-agent-hidden');
					card.createDiv({ text: `${r.item.title}: ${outcome.error ?? 'unknown error'}`, cls: 'auditor-proposal-error' });
				}
			}
			footer.addClass('auditor-agent-hidden');
			const saved = outcomes.filter((o) => o.ok).length;
			collapse(saved > 0 ? `Changes applied (${saved} of ${rows.length})` : 'No changes applied');
		},
		lock(text) {
			lockInputs();
			for (const r of rows) { r.badge.setText(text); r.badge.addClass('is-rejected'); r.link?.addClass('auditor-agent-hidden'); }
			footer.addClass('auditor-agent-hidden');
			collapse('No changes applied');
		},
	};
}
