---
name: CourseGrab
description: A quiet, professional desktop utility for saving your Udemy courses offline.
colors:
  accent: "#2F5BEA"
  accent-hover: "#2449CC"
  accent-soft: "#E8EEFE"
  canvas: "#F7F8FA"
  surface: "#FFFFFF"
  sidebar: "#F1F3F6"
  border: "#E3E6EB"
  text: "#14171C"
  text-muted: "#5A6270"
  success: "#157F55"
  warning: "#9A6408"
  danger: "#C62F2B"
  dark-canvas: "#0E1013"
  dark-surface: "#16191E"
  dark-sidebar: "#12151A"
  dark-border: "#262B33"
  dark-text: "#ECEEF2"
  dark-text-muted: "#A0A8B5"
  dark-accent: "#7B97FF"
  border-strong: "#CDD2DA"
  text-faint: "#626A78"
  success-soft: "#E3F4EC"
  warning-soft: "#FBF0D9"
  danger-soft: "#FBE7E6"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', system-ui, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  heading:
    fontSize: "16px"
    fontWeight: 600
  caption:
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontSize: "12px"
    fontWeight: 500
rounded:
  control: "8px"
  card: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
---

# Design System: CourseGrab

## Overview
**Creative North Star: "The Quiet Utility."** The app is a tool people start and walk away from, so the interface stays calm, neutral and legible, and lets state (downloading, paused, done, failed) do the talking. Restrained colour: cool neutrals plus one cobalt accent used only for the primary action, the current selection and progress. Success, warning and danger colours appear only as state, never as decoration. Familiar affordances everywhere: sidebar navigation, list rows, switches, native selects. Craft bar: Apple Music and Podcasts, Raycast, Vercel and Linear.

## Colors
Restrained strategy. Accent `#2F5BEA` (dark theme `#7B97FF`). A second neutral layer (`sidebar`) separates navigation from content. Text muted is tinted from the neutral hue, never pure grey. Light and dark are both first-class and follow `prefers-color-scheme`.

## Typography
System UI stack only, so the app feels native on each OS and covers every locale, including Arabic. Fixed scale, not fluid: 12 (label), 13 (caption), 14 (body), 16 (heading), 22 (title). Weights 400, 500, 600. Tabular numerals for speeds, counts and percentages.

## Layout
Sidebar (220px, collapses to icons below 860px) plus a scrolling content column with a sticky header. Content max width 920px for lists, 680px for settings; the sticky header shares the list width. 4px base spacing unit. Logical CSS properties throughout so RTL mirrors correctly.

## Elevation & Depth
Flat. Depth comes from 1px borders and tonal layers (canvas, surface, sidebar). Shadows are reserved for dialogs and toasts.

## Shapes
8px controls, 12px cards and grouped lists, pill for status chips and the badge. 1px borders.

## Components
Buttons: primary (accent fill), secondary (surface with border), ghost, danger. Switch for boolean options. Native select and input, restyled. Course row: thumbnail, title, status line, one primary action. Download row adds a progress bar, a "Lecture 14/62 · 720p · 2.4 MB/s" line and Pause/Resume/Cancel; done rows offer Open folder; failed rows state the cause and Retry. Dialogs use native `<dialog>`. Toasts confirm saves and report recoverable errors.

## Do's and Don'ts
- Do show state with text plus colour, never colour alone.
- Do keep one primary action per row and per screen.
- Do use skeletons and inline busy states, not full-window blockers.
- Don't add decorative gradients, glows, glass or coloured side borders.
- Don't use more than one accent colour, or the accent for status.
- Don't hide primary actions in icon-only buttons; icon-only buttons always carry a label for assistive tech and a tooltip.
