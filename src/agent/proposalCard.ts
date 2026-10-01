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

type ItemDecision = 'accepted' | 'rejected' | null;

interface ItemHandle {
	item: ReviewItem;
	getDecision(): ItemDecision;
	getComment(): string;
	/** Used by the container's "Accept all"/"Reject all" — a no-op once the item is locked. */
	setDecision(next: ItemDecision): void;
	badge: HTMLElement;
	link: HTMLElement | null;
	lockInputs(): void;
}

/**
 * One reviewable item (a control, a control+stage pair, or a whole session plan) as its own
 * self-contained card: diffs, an explicit Accept/Reject pair (no decision is pre-selected — the
 * user must choose), and its own comment box. A rejection requires a non-empty comment before the
 * container's "Submit review" will accept it, since a reject with nothing to act on gives the
 * agent's refinement pass nothing to go on; a comment on an acceptance is always optional.
 */
function renderItem(parent: HTMLElement, item: ReviewItem, onDecisionChange: () => void): ItemHandle {
	const card = parent.createDiv('auditor-proposal-change');
	const head = card.createDiv('auditor-proposal-change-head');
	const titleWrap = head.createDiv('auditor-proposal-change-title');
	titleWrap.createSpan({ text: item.title, cls: 'auditor-proposal-number' });
	if (item.subtitle) titleWrap.createSpan({ text: item.subtitle, cls: 'auditor-proposal-topic' });
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

	const decisionRow = card.createDiv('auditor-proposal-decision-row');
	const acceptBtn = decisionRow.createEl('button', { text: 'Accept', cls: 'auditor-proposal-accept' });
	const rejectBtn = decisionRow.createEl('button', { text: 'Reject', cls: 'auditor-proposal-reject' });
	const statusSpan = decisionRow.createSpan({ text: 'Not yet decided', cls: 'auditor-proposal-decision-status' });

	const commentWrap = card.createDiv('auditor-proposal-comment-wrap auditor-agent-hidden');
	commentWrap.createEl('label', { text: 'Comment', cls: 'auditor-proposal-field-label' });
	const comment = commentWrap.createEl('textarea', { cls: 'auditor-pipeline-textarea auditor-proposal-item-comment' });
	comment.rows = 2;
	const commentHint = commentWrap.createEl('p', { cls: 'auditor-field-description' });

	let decision: ItemDecision = null;
	let locked = false;

	const refreshDecisionUi = () => {
		acceptBtn.toggleClass('is-selected', decision === 'accepted');
		rejectBtn.toggleClass('is-selected', decision === 'rejected');
		statusSpan.setText(decision === 'accepted' ? 'Accepted' : decision === 'rejected' ? 'Rejected' : 'Not yet decided');
		commentWrap.toggleClass('auditor-agent-hidden', decision === null);
		commentHint.setText(decision === 'rejected' ? 'Required: tell the agent what to change.' : 'Optional note.');
		comment.placeholder = decision === 'rejected' ? 'What should change?' : 'Optional note for the agent…';
	};
	refreshDecisionUi();

	/** Sets the decision outright (used by the "Accept all"/"Reject all" bulk actions). */
	const setDecision = (next: ItemDecision) => {
		if (locked) return;
		decision = next;
		refreshDecisionUi();
		onDecisionChange();
	};
	/** A button click toggles: clicking the already-selected choice clears back to undecided. */
	const toggleDecision = (next: ItemDecision) => setDecision(decision === next ? null : next);
	acceptBtn.addEventListener('click', () => toggleDecision('accepted'));
	rejectBtn.addEventListener('click', () => toggleDecision('rejected'));
	comment.addEventListener('input', onDecisionChange);

	return {
		item,
		getDecision: () => decision,
		getComment: () => comment.value.trim(),
		setDecision,
		badge,
		link,
		lockInputs: () => {
			locked = true;
			acceptBtn.disabled = true;
			rejectBtn.disabled = true;
			comment.disabled = true;
		},
	};
}

export interface ProposalCardHandle {
	/** Locks the card and shows which changes were saved / failed. */
	showOutcomes(outcomes: ApplyOutcome[]): void;
	/** Locks the card without writing anything (rejected, or the run was stopped). */
	lock(text: string): void;
}

/** Renders the proposed changes as independently-decided items with a single bulk "Submit review" — resolves `decide` once the user has made an explicit choice for every item and submits. */
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

	const rows = proposal.items.map((item) => item); // keep order
	const footer = card.createDiv('auditor-proposal-footer');
	const bulkButtons = footer.createDiv('auditor-proposal-bulk-buttons');
	const acceptAllBtn = bulkButtons.createEl('button', { text: 'Accept all' });
	const rejectAllBtn = bulkButtons.createEl('button', { text: 'Reject all' });
	const submitRow = footer.createDiv('auditor-proposal-submit-row');
	const submitHint = submitRow.createSpan({ cls: 'auditor-proposal-submit-hint' });
	const submitBtn = submitRow.createEl('button', { text: 'Submit review', cls: 'mod-cta' });

	const handles: ItemHandle[] = rows.map((item) => renderItem(card, item, () => updateSubmitState()));

	// Only sets items still undecided (or already matching), never overwrites a choice the user made explicitly on one item — a bulk action is a starting point, not a silent overwrite of hand-picked decisions.
	acceptAllBtn.addEventListener('click', () => {
		for (const h of handles) if (h.getDecision() === null) h.setDecision('accepted');
	});
	rejectAllBtn.addEventListener('click', () => {
		for (const h of handles) if (h.getDecision() === null) h.setDecision('rejected');
	});

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
		for (const h of handles) h.lockInputs();
		submitBtn.disabled = true;
		acceptAllBtn.disabled = true;
		rejectAllBtn.disabled = true;
	};

	function updateSubmitState(): void {
		if (settled) return;
		const undecided = handles.filter((h) => h.getDecision() === null).length;
		const rejectedWithoutComment = handles.filter((h) => h.getDecision() === 'rejected' && h.getComment() === '').length;
		const ready = undecided === 0 && rejectedWithoutComment === 0;
		submitBtn.disabled = !ready;
		submitHint.setText(
			undecided > 0
				? `${undecided} item${undecided === 1 ? '' : 's'} not yet decided`
				: rejectedWithoutComment > 0
					? `${rejectedWithoutComment} rejection${rejectedWithoutComment === 1 ? '' : 's'} need a comment`
					: '',
		);
	}
	updateSubmitState();

	submitBtn.addEventListener('click', () => {
		if (settled || submitBtn.disabled) return;
		lockInputs();
		const approved = handles.filter((h) => h.getDecision() === 'accepted').map((h) => h.item.key);
		const rejected = handles.filter((h) => h.getDecision() === 'rejected').map((h) => h.item.key);
		const comments: Record<string, string> = {};
		for (const h of handles) {
			const c = h.getComment();
			if (c) comments[h.item.key] = c;
		}
		decide({ approved, rejected, comments });
	});

	return {
		showOutcomes(outcomes) {
			const byNumber = new Map(outcomes.map((o) => [o.key, o]));
			for (const r of handles) {
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
			collapse(saved > 0 ? `Changes applied (${saved} of ${handles.length})` : 'No changes applied');
		},
		lock(text) {
			lockInputs();
			for (const r of handles) { r.badge.setText(text); r.badge.addClass('is-rejected'); r.link?.addClass('auditor-agent-hidden'); }
			footer.addClass('auditor-agent-hidden');
			collapse('No changes applied');
		},
	};
}
