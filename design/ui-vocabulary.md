# UI vocabulary — the recurring class recipes

> **Superseded 2026-09-12 by `docs/STYLE.md`**, which absorbed these recipes
> and is the published style guide (`design/` stays local). Update STYLE.md,
> not this file.

Extracted from the running code on 2026-08-15 by counting how often each
class combination appears in `frontend/src/components/`. This is a
description, not an invention: every recipe below is what the app already
does most often. New UI must reuse these rather than inventing a neighbour
that is 1 px different.

Rule from CLAUDE.md that governs all of them: colour only through the token
families the `:root[data-theme]` blocks remap — `gray-*` for neutrals,
`blue-*` for accents, `amber-*` for warnings, `red-*` reserved for errors.
No hex values, no brand colours.

## Cards

| Purpose | Recipe |
|---|---|
| Guided/info card (CloudSetupNotice) | `rounded-xl bg-blue-50/60 border border-blue-100 p-4 space-y-3` |
| Compact info strip | `rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2.5` |
| Card heading | `text-sm font-semibold text-gray-900` + Lucide 15 px, `text-blue-600` |
| Card body | `text-[13px] leading-relaxed text-gray-700` |
| Footnote under a card | `text-[11px] text-gray-400` |

## Buttons

| Purpose | Recipe |
|---|---|
| Accent action (the one real exit) | `inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-[12px] font-semibold text-blue-700 transition-colors hover:bg-blue-100` |
| Plain action (secondary) | `inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700` |
| Filled primary (dialogs only) | `rounded-xl text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 transition-colors disabled:opacity-50` |
| Quiet blue text button | `rounded-lg text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors` |
| Icon inside a button | Lucide **11 px** next to `text-[12px]` labels |

## Badges

| Purpose | Recipe |
|---|---|
| Warning / cooldown | `rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[10px] font-semibold text-amber-700 whitespace-nowrap` |
| Same shape, other meanings | swap the family only: `blue-100/blue-50/blue-700` for a task, `green-200/green-50/green-700` for a confirmed state, `gray-200/gray-50/gray-500` for unknown |
| Icon inside a badge | Lucide **9–10 px** |

## Menu rows (ModelPicker, mockups §01–§07)

| Element | Recipe |
|---|---|
| Menu shell | `w-72 rounded-xl border border-gray-200 bg-white shadow-lg p-1.5 text-sm` |
| Row | `flex items-start gap-2 px-2.5 py-2 rounded-lg`, active `bg-blue-50`, hover `bg-gray-50` |
| Row title | `block font-semibold text-[13px] text-gray-900 truncate` |
| Row subtitle | `block text-[11.5px] text-gray-500` |
| Group heading | `px-2.5 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wider` |
| Separator | `h-px bg-gray-100 my-1 mx-1` |
| Quota meter | track `w-8 h-1 rounded-full bg-gray-200`, fill `bg-green-600`, label `font-mono text-[10px]` |
| Active check mark | Lucide 14 px, `text-blue-700` |
| Footer status | `px-2.5 pt-1.5 pb-0.5 text-[11px] text-gray-500` + a 1.5 px dot |

## Chips (composer attachments)

Measured from `AttachmentChip.tsx` — chips are **pill-shaped and border-less**,
which the first draft of this file got wrong.

| Element | Recipe |
|---|---|
| Attachment chip | `inline-flex items-center gap-2 rounded-full bg-gray-100 pl-1 pr-2 py-0.5 text-xs text-gray-700` |
| Warning variant | same shape, `bg-amber-100 text-amber-700`, `px-2` (no avatar to inset for) |

## Size ladder

Text: `10px` badges · `11px` footnotes · `11.5px` subtitles · `12px` buttons ·
`12.5px` pill labels · `13px` row titles and card bodies · `text-sm` (14 px)
headings.

Radii: `rounded-md` buttons · `rounded-lg` rows and chips · `rounded-xl`
cards and menus · `rounded-full` badges and pills.

Icons: `9–10 px` in badges · `11 px` in buttons · `12–14 px` in rows ·
`15 px` in card headings.
