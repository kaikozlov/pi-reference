// ─── Fuzzy filter for `/reference` argument autocomplete ─────────────

const WORD_SEPARATOR = /[\s\-_./:]/;

/**
 * Cost of `token` as a subsequence of `text` (both lowercased): lower ranks first, `Infinity`
 * when it does not match. Each character takes its first occurrence after the previous one, so a
 * match that starts earlier ranks before a later one, one at a word start before one inside a
 * word, and one without gaps before a scattered one.
 */
function matchCost(text: string, token: string): number {
	if (text === token) return -100;

	let cost = 0;
	let previous = -1;
	for (const char of token) {
		const at = text.indexOf(char, previous + 1);
		if (at === -1) return Number.POSITIVE_INFINITY;

		// Where the match starts counts once, each character skipped after that twice.
		cost += (at - previous - 1) * (previous === -1 ? 1 : 2);
		if (at === 0 || WORD_SEPARATOR.test(text[at - 1])) cost -= 10;
		previous = at;
	}
	return cost;
}

/**
 * Keep the items whose text contains every whitespace- or slash-separated token of `query` as a
 * case-insensitive subsequence, best matches first. A blank query keeps every item, as it is.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	const tokens = query.toLowerCase().split(/[\s/]+/).filter(Boolean);
	if (tokens.length === 0) return items;

	const matches: { item: T; cost: number }[] = [];
	for (const item of items) {
		const text = getText(item).toLowerCase();
		let cost = 0;
		for (const token of tokens) cost += matchCost(text, token);
		if (Number.isFinite(cost)) matches.push({ item, cost });
	}
	return matches.sort((a, b) => a.cost - b.cost).map(match => match.item);
}
