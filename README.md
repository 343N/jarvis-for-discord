# jarvis for discord
bot that lets u ask it questions via claude platform API i guess 

note: this was vibe coded out the ass

## env file

env file has settings and your api keys and shit

#### mandatory 
- DISCORD_TOKEN - discord app token (bot)

- ANTHROPIC_API_KEY - anthropic API key for clauding


#### optional

- ANTHROPIC_ADMIN_KEY - your anthropic admin key (i dont think this gets used tbh i havent checked lmao)
- DEFAULT_MODEL - sets default model. valid values are opus, sonnet, haiku, opus-5, sonnet-5 or haiku-4.5 (Fable is not allowed)
- SYSTEM_PROMPT - system prooompt im proomptinggg
- ALLOWED_SERVERS - servers (guilds) that this bot can operate in, so you dont get some yee-yee ass adding it thtier server and stealing all ur tokens (e.g. 951303485681293684,316897461284445665)


## pm2

if you use pm2 it'll put the bot offline as soon as the shutdown signal is sent so that the bot isn't faking being online lmao