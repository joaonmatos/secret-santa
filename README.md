# Secret Santa

Quickly draw names from secret santa and send emails telling people about their
own.

## Running

- Install [Deno](https://deno.land). The latest version should work, but this is
  as of 2022-11-25 and I am using v1.28.1.
- Install the [AWS CLI](). You should configure a profile called `SecretSanta`,
  that has enough IAM permissions to send emails with Amazon SES. Or change the
  loaded profile to something else you want.
- Change the email template and the origin email address to whatever you want,
  and whatever email address you control.
- Add a `data.json` file in the root of the directory and specify your input
  there: `people` key has people's names and emails, and `pools` has the people
  that can't gift each other. Something like the following:

```json
{
  "people": [
    { "name": "Alice", "email": "alice@example.com" },
    { "name": "Bob", "email": "bob@example.com" },
    { "name": "Cathrine", "email": "alice@example.com" },
    { "name": "Mike", "email": "mike@example.com" },
    { "name": "Hannah", "email": "hannah@example.com" }
  ],
  "pools": [
    ["Alice", "Cathrine"],
    ["Bob"],
    ["Mike"],
    ["Hannah"]
  ]
}
```

Run with `deno run --allow-env --allow-read --allow-net main.ts`

## Notes

- If an assignment is impossible, such as if there are only two pools and three
  participants, you're gonna get stuck on an infinite loop.
- SES is gonna blow up if you don't have prod access or try to send through my
  email address
