import jsonData from "./data.json" assert { type: "json" };

import { z } from "https://deno.land/x/zod@v3.19.1/mod.ts";

import {
  ApiFactory,
  SharedIniFileCredentials,
} from "https://deno.land/x/aws_api@v0.7.0/client/mod.ts";
import { SESV2 } from "https://aws-api.deno.dev/v0.3/services/sesv2.ts?actions=SendEmail";

/**
 * Validate input data. Should have a list of contacts under .people, and arrays of who
 * who is not allowed to gift each other under pools.
 * Todo: check that people with same email are in same pool.
 */
const DataSchema = z.object({
  people: z.object({
    name: z.string(),
    email: z.string(),
  }).array(),
  pools: z.string().array().array(),
}).refine(
  ({ people, pools }) => people.length === pools.flatMap((it) => it).length,
  "The total number of elements in people and pools should be the same",
).refine(
  ({ pools }) => {
    const flat = pools.flatMap((it) => it);
    return new Set(flat).size === flat.length;
  },
  "There should be no duplicates in the pools",
).refine(
  ({ people }) => {
    const flat = people.map((it) => it.name);
    return new Set(flat).size === flat.length;
  },
  "There should be no duplicates in the people list",
).refine(
  ({ people, pools }) => {
    const peopleSet = new Set(people.map((p) => p.name));
    return pools.flatMap((it) => it).every((person) => peopleSet.has(person));
  },
  "The names in the pools should correspond to the names in the people list",
);

const data = DataSchema.parse(jsonData);

type SecretSantaInput = z.infer<typeof DataSchema>;

/**
 * Generates random assignments until one of them fulfills the restrictions imposed by the pools
 */
class SecretSantaAssigner {
  #peopleSet: Set<string>;
  #peopleDetails: Map<string, { name: string; email: string }>;
  #poolMap: Map<string, Set<string>>;
  constructor(input: SecretSantaInput) {
    this.#peopleSet = new Set(input.people.map((p) => p.name));
    this.#peopleDetails = new Map(input.people.map((p) => [p.name, p]));
    this.#poolMap = new Map(input.pools.flatMap((pool) => {
      const poolSet = new Set(pool);
      return pool.map((person) => [person, poolSet]);
    }));
  }

  run() {
    let candidateAssignments: [string, string][];
    do {
      candidateAssignments = this.#makeAssignments();
    } while (!candidateAssignments.every((a) => this.#isOkayAssignment(a)));
    return candidateAssignments.map(this.#formatAssignment.bind(this));
  }

  #formatAssignment([giver, receiver]: [string, string]) {
    return {
      giverName: giver,
      giverEmail: this.#peopleDetails.get(giver)!.email,
      receiverName: receiver,
    };
  }

  /**
   * Shuffle array in place at random. From https://javascript.info/task/shuffle
   * @param array to shuffle
   */
  static #shuffle<T>(array: T[]) {
    for (let i = array.length - 1; i > 0; i--) {
      let j = Math.floor(Math.random() * (i + 1)); // random index from 0 to i

      // swap elements array[i] and array[j]
      // we use "destructuring assignment" syntax to achieve that
      // you'll find more details about that syntax in later chapters
      // same can be written as:
      // let t = array[i]; array[i] = array[j]; array[j] = t
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  #isOkayAssignment([giver, receiver]: [string, string]) {
    return this.#peopleSet.has(giver) &&
      this.#peopleSet.has(receiver) &&
      !(this.#poolMap.get(giver)?.has(receiver) ?? false);
  }

  #makeAssignments(): [string, string][] {
    const givers = [...this.#peopleSet];
    const receivers = [...givers];
    SecretSantaAssigner.#shuffle(receivers);
    return givers.map((giver, ix) => [giver, receivers[ix]]);
  }
}

const assigner = new SecretSantaAssigner(data);

const assignments = assigner.run();

type ConsolidatedAssignments = Record<
  string,
  { giver: string; receiver: string }[]
>;

/**
 * Consolidated assignments by email, for when people want to use the same email for different people
 */
const consolidatedAssignments = assignments.reduce(
  (acc, { giverEmail: email, giverName: giver, receiverName: receiver }) => {
    const currentRecords = acc[email] ?? [];
    return { ...acc, [email]: [{ giver, receiver }, ...currentRecords] };
  },
  {} as ConsolidatedAssignments,
);

function formatEmail(
  assignments: ConsolidatedAssignments[string],
) {
  return "Olá! Aqui estão os amigos ocultos que te são relevantes:\n" +
    `${
      assignments.map((assignment) =>
        ` - ${assignment.giver} vai dar presente a ${assignment.receiver}`
      ).join("\n")
    }`;
}

const ses = new ApiFactory({
  credentialProvider: new SharedIniFileCredentials({ profile: "SecretSanta" }),
  region: "eu-central-1",
}).makeNew(SESV2);

for (const email of Object.keys(consolidatedAssignments)) {
  const assignments = consolidatedAssignments[email];

  await ses.sendEmail({
    "FromEmailAddress": "secret-santa@secret-santa.joaonmatos.com",
    Destination: {
      ToAddresses: [email],
    },
    Content: {
      Simple: {
        Subject: {
          Data: `Amigo oculto 2022`,
        },
        Body: {
          Text: {
            Data: formatEmail(assignments),
          },
        },
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));
}
