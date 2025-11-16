import express from 'express'

const router = express.Router()

router.use((req, res) => {
  res.status(501).json({
    error: 'DeepSeek integration coming soon',
    message: 'DeepSeek API support is scaffolded but not yet connected. Please use the Google, Perplexity, or OpenRouter services for now.'
  })
})

export default router

