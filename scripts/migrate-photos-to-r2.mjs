#!/usr/bin/env node
// One-time migration: copies every object in the Supabase `restaurant-photos`
// bucket into the R2 bucket at the same key, verifying byte-for-byte size
// match as it goes. Read-only against Supabase — it never deletes there;
// use scripts/delete-supabase-photos.mjs for that, once R2 is verified.
//
// Run with: node --env-file=.env scripts/migrate-photos-to-r2.mjs
//
// Reads over the bucket's public URL (no Supabase auth needed — the bucket
// is public) rather than the storage SDK's authenticated download, which
// would need an RLS policy the anon key doesn't necessarily have. The object
// list below was pulled once from `storage.objects` via the Supabase MCP
// (45 objects, 29,059,908 bytes total as of 2026-08-21) — a fixed manifest
// for a one-time script, not a general-purpose lister.
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

function required(name) {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not set`);
	return v;
}

const SUPABASE_URL = required('SUPABASE_URL');
const BUCKET = 'restaurant-photos';

const r2 = new S3Client({
	region: 'auto',
	endpoint: `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: required('R2_ACCESS_KEY_ID'),
		secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
	},
});
const R2_BUCKET = required('R2_BUCKET');

const OBJECTS = [
	{ path: '1/1786744881233-jzgc7h.jpg', size: 1288322 },
	{ path: '10/1786798365829-csxy8r.jpg', size: 793351 },
	{ path: '10/1786798369801-oq87ft.jpg', size: 1031108 },
	{ path: '10/1786798373422-l3zqdo.jpg', size: 847738 },
	{ path: '10/1786798408717-hlwkg7.jpg', size: 1050863 },
	{ path: '10/1786798413024-48mlw4.jpg', size: 1128126 },
	{ path: '11/1786854137489-lm9npm.jpg', size: 461431 },
	{ path: '11/1786854140048-poj8zw.jpg', size: 546999 },
	{ path: '11/1786854142394-bmfhxh.jpg', size: 448567 },
	{ path: '12/1786854291063-l3hk1x.jpg', size: 664896 },
	{ path: '13/1786854491674-hwyu44.jpg', size: 659992 },
	{ path: '13/1786854494413-764gvn.jpg', size: 489573 },
	{ path: '13/1786854496602-3frfz2.jpg', size: 475931 },
	{ path: '13/1786854498959-sky27s.jpg', size: 493764 },
	{ path: '14/1786854659234-zqoy8b.jpg', size: 349125 },
	{ path: '14/1786854661715-ft19ff.jpg', size: 498829 },
	{ path: '14/1786854664127-1jlb5w.jpg', size: 586470 },
	{ path: '14/1786854667648-ynea2c.jpg', size: 604277 },
	{ path: '14/1786854673550-kbmtc1.jpg', size: 576514 },
	{ path: '14/1786854677518-z19z63.jpg', size: 482146 },
	{ path: '14/1786854680381-he6x4x.jpg', size: 426534 },
	{ path: '15/1786854908917-8bo7hr.jpg', size: 953102 },
	{ path: '15/1786854911633-b5gawp.jpg', size: 664129 },
	{ path: '15/1786854914685-j2ferf.jpg', size: 636191 },
	{ path: '15/1786854918737-6yf91o.jpg', size: 622153 },
	{ path: '16/1786855067071-s9dsas.jpg', size: 881238 },
	{ path: '17/1786870480655-vwesj2.jpg', size: 448930 },
	{ path: '18/1787058466378-7jswnn.jpg', size: 443412 },
	{ path: '19/1787107245010-n7wuzl.jpg', size: 391526 },
	{ path: '19/1787107247184-oqdg1i.jpg', size: 529763 },
	{ path: '19/1787107249172-l2dv2s.jpg', size: 508356 },
	{ path: '19/1787107251295-jax2bl.jpg', size: 523586 },
	{ path: '19/1787107253076-thrts8.jpg', size: 461013 },
	{ path: '2/1786853999139-4tl24x.jpg', size: 695539 },
	{ path: '20/1787162240131-pat2r5.jpg', size: 516422 },
	{ path: '21/1787185306450-qwxnow.jpg', size: 579835 },
	{ path: '21/1787185310451-131soy.jpg', size: 614706 },
	{ path: '3/1786745296383-3sge83.jpg', size: 557322 },
	{ path: '5/1786745510832-pc3qyo.jpg', size: 655269 },
	{ path: '6/1786745968565-7bnxr6.jpg', size: 806319 },
	{ path: '6/1786746007011-yg7ily.jpg', size: 780810 },
	{ path: '6/1786746010313-uun6a4.jpg', size: 654958 },
	{ path: '7/1786796239809-quhct7.jpg', size: 551415 },
	{ path: '8/1786796593202-j7aiax.jpg', size: 638142 },
	{ path: '9/1786796850141-xalw2z.jpg', size: 1041216 },
];

async function alreadyInR2(path) {
	try {
		const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: path }));
		return head.ContentLength ?? null;
	} catch (e) {
		if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
		throw e;
	}
}

async function main() {
	console.log(`Migrating ${OBJECTS.length} objects to R2 bucket "${R2_BUCKET}".`);

	let copied = 0;
	let skipped = 0;
	let failed = 0;

	for (const obj of OBJECTS) {
		const existingSize = await alreadyInR2(obj.path);
		if (existingSize === obj.size) {
			skipped++;
			continue;
		}

		const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${obj.path}`;
		const res = await fetch(url);
		if (!res.ok) {
			console.error(`FAILED download ${obj.path}: HTTP ${res.status}`);
			failed++;
			continue;
		}
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (bytes.byteLength !== obj.size) {
			console.error(`FAILED ${obj.path}: downloaded ${bytes.byteLength} bytes, expected ${obj.size}`);
			failed++;
			continue;
		}

		await r2.send(
			new PutObjectCommand({
				Bucket: R2_BUCKET,
				Key: obj.path,
				Body: bytes,
				ContentType: res.headers.get('content-type') || 'image/jpeg',
				CacheControl: 'public, max-age=31536000, immutable',
			}),
		);

		const verifySize = await alreadyInR2(obj.path);
		if (verifySize !== bytes.byteLength) {
			console.error(`FAILED verify ${obj.path}: R2 has ${verifySize} bytes after upload`);
			failed++;
			continue;
		}

		copied++;
		console.log(`copied ${obj.path} (${bytes.byteLength} bytes)`);
	}

	console.log(`\nDone. copied=${copied} skipped(already present)=${skipped} failed=${failed}`);
	if (failed > 0) {
		console.error('Some objects failed — Supabase originals untouched. Re-run to retry.');
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
