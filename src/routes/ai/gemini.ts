// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')

//Model instances
// /suggest  — gemini-2.5-flash: benefits from deep reasoning to find non-obvious
//             connections across a user's notes.
// /discover — gemini-2.5-flash-lite: simple recommendation task; no thinking overhead,
//             significantly faster cold response (~1-2s vs ~4-6s).

export const suggestModel = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: {
    responseMimeType: 'application/json',
    maxOutputTokens: 4096,
  },
})

export const discoverModel = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash-lite',
  generationConfig: {
    responseMimeType: 'application/json',
    maxOutputTokens: 300, // single {title, creator, reason} needs ~100 tokens
  },
})
