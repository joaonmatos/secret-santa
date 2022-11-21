import type { Credentials, CredentialsProvider } from "./common.ts";
import { IMDSv2 } from "./instance-metadata.ts";
import { BaseApiFactory } from './client.ts';

export type { Credentials, CredentialsProvider } from "./common.ts";

// If more than one credential source is available to the SDK, the default precedence of selection is as follows:
//  1. Credentials that are explicitly set through the service-client constructor
//  2. Environment variables
//  3. The shared credentials file
//  4. Credentials loaded from the ECS credentials provider
//  5. Credentials that are obtained by using a credential process specified in the shared AWS config file or the shared credentials file
//  6. Credentials loaded from AWS IAM using the credentials provider of the Amazon EC2 instance
// https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-credentials-node.html

export class CredentialsProviderChain implements CredentialsProvider {
  #chain: (() => CredentialsProvider)[];
  #supplier?: CredentialsProvider;
  constructor(chain: Array<() => CredentialsProvider>) {
    this.#chain = chain;
  }
  async getCredentials(): Promise<Credentials> {
    if (this.#supplier) return this.#supplier.getCredentials();

    const errors: Array<string> = [];
    for (const providerFunc of this.#chain) {
      try {
        const provider = providerFunc();
        const creds = await provider.getCredentials();
        this.#supplier = provider;
        return creds;
      } catch (err) {
        const providerLabel = providerFunc.toString().replace(/^\(\) => new /, '');
        const srcName = `    - ${providerLabel} `;
        if (err instanceof Error) {
          // if (err.message !== 'No credentials found') {
            errors.push(srcName+(err.stack?.split('\n')[0] || err.message));
          // }
        } else if (err) {
          errors.push(srcName+err.toString());
        }
      }
    }
    return Promise.reject(new Error([
      `Failed to load any possible AWS credentials:`,
    ...errors].join('\n')));
  }
}

export const DefaultCredentialsProvider
  = new CredentialsProviderChain([
    () => new EnvironmentCredentials('AWS'),
    () => new EnvironmentCredentials('AMAZON'),
    () => new SharedIniFileCredentials(),
    () => new EcsTaskCredentials(),
    // () => new ProcessCredentials(),
    () => new TokenFileWebIdentityCredentials(),
    () => new EC2MetadataCredentials(),
  ]);

// full spec: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html
import * as ini from './ini.ts';
export class SharedIniFileCredentials implements CredentialsProvider {
  #filename: string;
  #filedata?: string;
  #profile: string;
  #promise?: Promise<Credentials>;
  constructor({
    profile,
    filename,
    filedata,
  }: {
    profile?: string,
    filename?: string,
    filedata?: string,
  }={}) {

    if (filedata) {
      filename = filename || 'tmp://supplied-inline';
      this.#filedata = filedata;
    }
    if (!filename) {
      filename = Deno.env.get('AWS_SHARED_CREDENTIALS_FILE');
    }
    if (!filename) {
      // TODO: this will probably go wrong on windows
      const HOME = Deno.env.get('HOME');
      filename = HOME+'/.aws/credentials';
    }
    this.#filename = filename;

    if (!profile) {
      profile = Deno.env.get('AWS_PROFILE');
    }
    this.#profile = profile || 'default';
  }

  getCredentials(): Promise<Credentials> {
    if (!this.#promise) this.#promise = this.load();
    return this.#promise;
  }

  async load(): Promise<Credentials> {
    const text = this.#filedata ?? await Deno.readTextFile(this.#filename);
    const data: {[name: string]: {
      aws_access_key_id?: string;
      aws_secret_access_key?: string;
      aws_session_token?: string;
      credential_process?: string;
      region?: string;
      // from saml2aws
      x_principal_arn?: string;
      x_security_token_expires?: string;
    } | undefined } = ini.decode(text);
    const config = data[`profile ${this.#profile}`] ?? data[this.#profile];
    if (!config) throw new Error(`Profile ${this.#profile} not found in credentials file`);
    if (!config.aws_access_key_id || !config.aws_secret_access_key) {
      throw new Error(`Profile ${this.#profile} lacks static credentials`);
    }
    return {
      awsAccessKeyId: config.aws_access_key_id,
      awsSecretKey: config.aws_secret_access_key,
      sessionToken: config.aws_session_token,
      region: config.region,
    };
  }
}

export class EnvironmentCredentials implements CredentialsProvider {
  #prefix: string;
  #promise?: Promise<Credentials>;
  constructor(prefix = 'AWS') {
    this.#prefix = prefix;
  }

  getCredentials(): Promise<Credentials> {
    if (!this.#promise) this.#promise = this.load();
    return this.#promise;
  }

  load(): Promise<Credentials> {
    const AWS_ACCESS_KEY_ID = Deno.env.get(this.#prefix+"_ACCESS_KEY_ID");
    const AWS_SECRET_ACCESS_KEY = Deno.env.get(this.#prefix+"_SECRET_ACCESS_KEY");
    const AWS_SESSION_TOKEN = Deno.env.get(this.#prefix+"_SESSION_TOKEN");

    if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
      return Promise.reject(new Error(`${this.#prefix} environment variables not set`));
    }

    return Promise.resolve({
      awsAccessKeyId: AWS_ACCESS_KEY_ID,
      awsSecretKey: AWS_SECRET_ACCESS_KEY,
      sessionToken: AWS_SESSION_TOKEN,
    });
  }
}

// https://docs.aws.amazon.com/sdkref/latest/guide/feature-container-credentials.html
/**
 * Implements the "IAM roles for tasks" feature of Amazon ECS.
 * Dynamically fetches credentials from the ECS runtime via HTTP.
 */
export class EcsTaskCredentials implements CredentialsProvider {
  #credUrl?: string;
  #headers: Headers;
  #promise: Promise<Credentials> | null = null;
  #expireAfter: Date | null = null;

  constructor(opts: {
    relativeUri?: string;
    fullUri?: string;
    serviceEndpoint?: string;
    authHeader?: string;
  }={}) {
    const relativeUri = opts.relativeUri
      || Deno.env.get('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
    const fullUri = opts.fullUri
      || Deno.env.get('AWS_CONTAINER_CREDENTIALS_FULL_URI');
    const serviceEndpoint = opts.serviceEndpoint
      || Deno.env.get('AWS_CONTAINER_SERVICE_ENDPOINT')
      || 'http://169.254.170.2';
    const authHeader = opts.authHeader
      || Deno.env.get('AWS_CONTAINER_AUTHORIZATION_TOKEN');

    this.#credUrl = relativeUri
      ? new URL(relativeUri, serviceEndpoint).toString()
      : fullUri;
    this.#headers = new Headers({
      'accept': 'application/json',
    });
    if (authHeader) {
      this.#headers.set('authorization', authHeader);
    }
  }

  getCredentials(): Promise<Credentials> {
    if (this.#expireAfter && this.#expireAfter < new Date()) {
      this.#expireAfter = null;
      this.#promise = null;
    }

    if (!this.#promise) {
      const promise = this.load();
      this.#promise = promise.then(x => {
        if (x.expiresAt && x.expiresAt > new Date()) {
          this.#expireAfter = new Date(x.expiresAt.valueOf() - 60*1000);
        }
        return x;
      }, err => {
        this.#expireAfter = new Date(Date.now() + 30*1000);
        return Promise.reject(err);
      });
    }

    return this.#promise;
  }

  async load(): Promise<Credentials> {
    if (!this.#credUrl) throw new Error(
      `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI not set`);

    const resp = await fetch(this.#credUrl, {
      headers: this.#headers,
      signal: (AbortSignal as any).timeout?.(5000), // starting Deno 1.20
    });
    if (resp.status >= 300) throw new Error(
      `ECS service endpoint returned HTTP ${resp.status}`);

    const data: {
      AccessKeyId: string;
      SecretAccessKey: string;
      Token: string;
      Expiration: string; // RFC 3339
      RoleArn: string;
    } = await resp.json();

    const expiration = new Date(data.Expiration);
    if (expiration.toString() === 'Invalid Date') throw new Error(
      `Failed to parse ECS expiration date: ${JSON.stringify(data.Expiration)}`);

    return Promise.resolve({
      awsAccessKeyId: data.AccessKeyId,
      awsSecretKey: data.SecretAccessKey,
      sessionToken: data.Token,
      expiresAt: new Date(data.Expiration),
    });
  }
}

export class TokenFileWebIdentityCredentials implements CredentialsProvider {
  #roleArn?: string;
  #tokenPath?: string;
  #sessionName: string;
  #promise: Promise<Credentials> | null = null;
  #expireAfter: Date | null = null;

  constructor(opts: {
    roleArn?: string;
    tokenPath?: string;
    sessionName?: string;
  }={}) {
    this.#roleArn = opts.roleArn
      || Deno.env.get('AWS_ROLE_ARN');
    this.#tokenPath = opts.tokenPath
      || Deno.env.get('AWS_WEB_IDENTITY_TOKEN_FILE');
    this.#sessionName = opts.sessionName
      || Deno.env.get('AWS_ROLE_SESSION_NAME')
      || 'token-file-web-identity';
  }

  // We can't expire using setTimeout because that hangs Deno
  // https://github.com/denoland/deno/issues/6141
  getCredentials(): Promise<Credentials> {
    if (this.#expireAfter && this.#expireAfter < new Date()) {
      this.#expireAfter = null;
      this.#promise = null;
    }

    if (!this.#promise) {
      const promise = this.load();
      this.#promise = promise.then(x => {
        if (x.expiresAt && x.expiresAt > new Date()) {
          this.#expireAfter = new Date(x.expiresAt.valueOf() - 60*1000);
        }
        return x;
      }, err => {
        this.#expireAfter = new Date(Date.now() + 30*1000);
        return Promise.reject(err);
      });
    }

    return this.#promise;
  }

  async load(): Promise<Credentials> {
    if (!this.#tokenPath) throw new Error(`No WebIdentityToken file path is set`);
    if (!this.#roleArn) throw new Error(`No Role ARN is set`);

    const client = new BaseApiFactory({
      // TODO: give a region here when AWS_STS_REGIONAL_ENDPOINTS=regional
      // https://github.com/cloudydeno/deno-aws_api/issues/2
      region: 'us-east-1',
      endpointResolver: new AwsEndpointResolver({
        forceRegional: false, // TODO as above
      }),
      credentialProvider: { getCredentials: () => Promise.reject(new Error(
        `No credentials necesary to AssumeRoleWithWebIdentity`)) },
    }).buildServiceClient(StsApiMetadata);

    const resp = await assumeRoleWithWebIdentity(client, {
      RoleArn: this.#roleArn,
      RoleSessionName: this.#sessionName,
      WebIdentityToken: await Deno.readTextFile(this.#tokenPath),
    });

    return Promise.resolve({
      awsAccessKeyId: resp.AccessKeyId,
      awsSecretKey: resp.SecretAccessKey,
      sessionToken: resp.SessionToken,
      expiresAt: resp.Expiration,
    });
  }
}

export class EC2MetadataCredentials implements CredentialsProvider {
  #service: IMDSv2;
  #promise: Promise<Credentials> | null = null;
  #expireAfter: Date | null = null;

  constructor(opts: {
    client?: IMDSv2;
  }={}) {
    this.#service = opts.client ?? new IMDSv2;
  }

  // We can't expire using setTimeout because that hangs Deno
  // https://github.com/denoland/deno/issues/6141
  getCredentials(): Promise<Credentials> {
    if (this.#expireAfter && this.#expireAfter < new Date()) {
      this.#expireAfter = null;
      this.#promise = null;
    }

    if (!this.#promise) {
      const promise = this.load();
      this.#promise = promise.then(x => {
        if (x.expiresAt && x.expiresAt > new Date()) {
          this.#expireAfter = new Date(x.expiresAt.valueOf() - 60*1000);
        }
        return x;
      }, err => {
        this.#expireAfter = new Date(Date.now() + 30*1000);
        return Promise.reject(err);
      });
    }

    return this.#promise;
  }

  async load(): Promise<Credentials> {

    const roleListReq = this.#service
      .performRequest('GET', 'meta-data/iam/security-credentials/')
      .then(x => x ? x.split('\n') : [])
      .catch(err => {
        if ('status' in err && err.status === 404) throw new Error(
          `This EC2 Instance doesn't have an IAM instance role attached`);
        throw err;
      });

    const roleList = await roleListReq;
    if (roleList.length !== 1 || !roleList[0]) throw new Error(
      `Unexpected EC2 instance role list: ${JSON.stringify(roleList)}`);

    const credential: {
      Code: "Success" | string;
      LastUpdated: string;
      Type: "AWS-HMAC" | string;
      AccessKeyId: string;
      SecretAccessKey: string;
      Token: string;
      Expiration: string;
    } = JSON.parse(await this.#service
      .performRequest('GET', 'meta-data/iam/security-credentials/'+roleList[0]));
    if (credential.Code !== 'Success') throw new Error(
      `Unexpected EC2 instance credential code: ${credential.Code}`);
    if (credential.Type !== 'AWS-HMAC') throw new Error(
      `Unexpected EC2 instance credential type: ${credential.Type}`);

    return Promise.resolve({
      awsAccessKeyId: credential.AccessKeyId,
      awsSecretKey: credential.SecretAccessKey,
      sessionToken: credential.Token,
      expiresAt: new Date(credential.Expiration),
      region: await this.#service.performRequest('GET', 'meta-data/placement/region'),
    });
  }
}


export function getDefaultCredentials(): Promise<Credentials> {
  return DefaultCredentialsProvider.getCredentials();
}

export function getDefaultRegion(): string {
  const AWS_REGION = Deno.env.get("AWS_REGION");
  if (!AWS_REGION) {
    throw new Error("Set AWS_REGION environment variable");
  }
  return AWS_REGION;
};


//--------------------------------------------
// Embedded subset of STS for assuming roles
// Is it even worth saving the one STS file? idk

import type { ServiceClient, ApiMetadata } from "./common.ts";
import { readXmlResult, XmlNode } from "../encoding/xml.ts";
import { AwsEndpointResolver } from "./endpoints.ts";

const StsApiMetadata: ApiMetadata = {
  apiVersion: "2011-06-15",
  endpointPrefix: "sts",
  globalEndpoint: "sts.amazonaws.com",
  protocol: "query",
  serviceAbbreviation: "AWS STS",
  serviceFullName: "AWS Security Token Service",
  serviceId: "STS",
  signatureVersion: "v4",
  uid: "sts-2011-06-15",
  xmlNamespace: "https://sts.amazonaws.com/doc/2011-06-15/"
};

async function assumeRoleWithWebIdentity(sts: ServiceClient, params: {
  RoleArn: string;
  RoleSessionName: string;
  WebIdentityToken: string;
}): Promise<AssumedCredentials> {
  const body = new URLSearchParams([
    ["RoleArn", params["RoleArn"] ?? ''],
    ["RoleSessionName", params["RoleSessionName"] ?? ''],
    ["WebIdentityToken", params["WebIdentityToken"] ?? ''],
  ]);
  const resp = await sts.performRequest({
    action: "AssumeRoleWithWebIdentity",
    authType: "anonymous",
    body,
  });
  const xml = readXmlResult(await resp.text(), "AssumeRoleWithWebIdentityResult");
  return xml.first("Credentials", true, parseAssumedCredentials);
}

interface AssumedCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  Expiration: Date;
}
function parseAssumedCredentials(node: XmlNode): AssumedCredentials {
  return {
    ...node.strings({
      required: {"AccessKeyId":true,"SecretAccessKey":true,"SessionToken":true},
    }),
    Expiration: node.first("Expiration", true, x => parseXmlTimestamp(x.content)),
  };
}
function parseXmlTimestamp(str: string | undefined): Date {
  if (str?.includes('T')) return new Date(str);
  if (str?.length === 10) return new Date(parseInt(str) * 1000)
  throw new Error(`Timestamp from STS is unparsable: '${str}'`);
}
