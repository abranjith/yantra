---
name: exec-brief
description: Weekly executive brief
guidance: British English. CFO audience. Never speculate beyond the sources.
tags: [work, weekly]
---

# {{ title | text }}

## Executive Summary
<!-- guidance:
Lead with the headline revenue number, then explain the driver
in one sentence.
-->

{{ summary | markdown, max_words=200 }}

## Key Risks

{{ risks | list, min=3, max=5 }}

## Vendor Comparison

{{ comparison | table(Vendor, Price, Notes) }}

## Sources

{{ sources }}
