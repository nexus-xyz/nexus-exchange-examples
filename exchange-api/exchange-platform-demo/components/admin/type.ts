/*
 * The console's type scale.
 *
 * WHY THIS FILE EXISTS. An audit of the admin surface found fourteen distinct
 * font sizes in use — 7.5, 8, 8.5, 9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 19, 20
 * and 21. Fourteen sizes is not a scale, it is a set of independent guesses, and
 * the tell is that most of the steps are half a point: nobody can see the
 * difference between a 10.5px hint and an 11px hint in isolation, but a page
 * built from both reads as mush because no two things are decisively the same
 * size or decisively different.
 *
 * Seven steps, each with one job:
 *
 *   MICRO  9    mono, tracked, upper   field labels, column heads, badges, pills
 *   NOTE   11   Archivo                hints, footnotes, secondary prose
 *   DATA   11.5 mono, tabular          every number in a table or a row
 *   BODY   12   Archivo                prose, cell text, list items
 *   TITLE  13   Archivo 600            panel titles, control titles
 *   PAGE   20   Archivo 700            the h1
 *   FIGURE 22   mono 500, tabular      a headline metric
 *
 * ONE MICRO SIZE, THREE INKS. The old surface used 8 for badges, 8.5 for column
 * heads and 9 for section labels — half-point steps that carry no information at
 * that size and cost the console a consistent baseline. Hierarchy inside the micro
 * tier is carried by INK instead (FAINT < DIM < MUT < TXT), which is legible at 9px
 * where a half-point is not. The exception a reader might expect — heatmap tick
 * labels — is handled by printing fewer ticks, not smaller ones.
 *
 * DATA IS SMALLER THAN BODY, DELIBERATELY. 11.5 mono next to 12 Archivo optically
 * matches, because the mono face has the larger x-height; setting them to the same
 * number made the numbers look bigger than the words that labelled them.
 */

import type { CSSProperties } from "react";

import { ARCHIVO, MONO } from "@/lib/theme";

export const SIZE = {
  micro: 9,
  note: 11,
  data: 11.5,
  body: 12,
  title: 13,
  page: 20,
  figure: 22,
} as const;

/** Prose. Line height is part of the step — a size without one is half a decision. */
export function body(size: number = SIZE.body, lineHeight = 1.6): CSSProperties {
  return { fontFamily: ARCHIVO, fontSize: size, lineHeight };
}

/** A number. Tabular figures are not optional in a console: a column of digits
 *  that changes width as it updates cannot be scanned down. */
export function data(size: number = SIZE.data): CSSProperties {
  return { fontFamily: MONO, fontSize: size, fontVariantNumeric: "tabular-nums" };
}
