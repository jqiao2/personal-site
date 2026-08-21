// Photo storage: Cloudflare R2 (S3-compatible), replacing Supabase Storage —
// see the migration note in restaurants.ts for why.
//
// COST GUARD. R2's free tier is 10 GiB storage / 1M writes / 10M reads a
// month; past that, usage bills to whatever card is on the Cloudflare
// account. There is no hard spend cap on R2 itself, so `assertUnderCap()`
// is the substitute: every upload lists the bucket first and refuses to
// proceed if the total would cross SOFT_CAP_BYTES, well under the free
// tier's 10 GiB. A single-user diary that pre-resizes photos to a 1600 px
// long edge before upload (see MealEditor's `prepare()`) will not approach
// this for a very long time; the guard exists so a bug — an upload loop, a
// forgotten resize step — fails loudly as a thrown error instead of quietly
// becoming a bill.
import {
	S3Client,
	PutObjectCommand,
	DeleteObjectCommand,
	ListObjectsV2Command,
} from '@aws-sdk/client-s3';

function required(name: string, value: string | undefined): string {
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

const accountId = required('R2_ACCOUNT_ID', import.meta.env.R2_ACCOUNT_ID);
export const R2_BUCKET = required('R2_BUCKET', import.meta.env.R2_BUCKET);
const publicUrl = required('R2_PUBLIC_URL', import.meta.env.R2_PUBLIC_URL).replace(/\/$/, '');

export const r2 = new S3Client({
	region: 'auto',
	endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: required('R2_ACCESS_KEY_ID', import.meta.env.R2_ACCESS_KEY_ID),
		secretAccessKey: required('R2_SECRET_ACCESS_KEY', import.meta.env.R2_SECRET_ACCESS_KEY),
	},
});

/** Public URL for a stored object. The bucket is public, so pure string assembly. */
export function r2PublicUrl(path: string): string {
	return `${publicUrl}/${path}`;
}

/**
 * Refuses to proceed once the bucket's total stored bytes would cross this.
 * 8 GiB, not 10: the margin is there so an in-flight upload or two never
 * lands exactly on the free-tier edge.
 */
const SOFT_CAP_BYTES = 8 * 1024 ** 3;

/** Throws if the bucket is already at or over the soft cap. */
async function assertUnderCap(): Promise<void> {
	let total = 0;
	let continuationToken: string | undefined;
	do {
		const page = await r2.send(
			new ListObjectsV2Command({
				Bucket: R2_BUCKET,
				ContinuationToken: continuationToken,
			}),
		);
		for (const obj of page.Contents ?? []) total += obj.Size ?? 0;
		continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (continuationToken);

	if (total >= SOFT_CAP_BYTES) {
		throw new Error(
			`R2 bucket is at ${(total / 1024 ** 3).toFixed(2)} GiB, at or over the ` +
				`${SOFT_CAP_BYTES / 1024 ** 3} GiB soft cap — refusing to upload. This stops the ` +
				`bucket short of R2's 10 GiB free tier rather than letting it bill. Raise ` +
				`SOFT_CAP_BYTES in src/lib/r2.ts only once you've decided to accept that cost.`,
		);
	}
}

export async function putPhoto(
	path: string,
	body: Uint8Array,
	contentType: string | undefined,
): Promise<void> {
	await assertUnderCap();
	await r2.send(
		new PutObjectCommand({
			Bucket: R2_BUCKET,
			Key: path,
			Body: body,
			ContentType: contentType,
			// A year: the path is unique per upload (timestamp + random suffix)
			// and never rewritten, so nothing under it ever needs revalidating.
			CacheControl: 'public, max-age=31536000, immutable',
		}),
	);
}

export async function deletePhotoObject(path: string): Promise<void> {
	await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path }));
}
