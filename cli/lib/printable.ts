// Text an agent wrote (a proxy log field, a commit subject) on its way to the
// developer's terminal: no control character (C0, DEL, C1), so no escape
// sequence either, which could move the cursor and erase or rewrite what
// forge printed before.
export const printable = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

// Comme `printable`, mais garde le saut de ligne et la tabulation : un texte
// multi-ligne (le corps d'une PR, un commentaire) reste lisible.
export const printableText = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
