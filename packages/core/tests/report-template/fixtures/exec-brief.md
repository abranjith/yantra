---
name: exec-brief
description: Weekly executive brief
tags: [work, weekly]
---

# {{ title | text }}

## Executive Summary

{{ summary | markdown, max_words=200 }}

## Key Risks

{{ risks | list, min=3, max=5 }}

## Vendor Comparison

{{ comparison | table(Vendor, Price, Notes) }}

## Sources

{{ sources }}
