import {
	SocketConfig,
	WAMediaUpload,
	NewsletterMetadata,
	NewsletterReactionMode,
	NewsletterViewRole,
	XWAPaths,
	NewsletterReaction,
	NewsletterFetchedUpdate,
	QueryIds // DIIMPOR DARI TYPES
} from '../Types'
import { decryptMessageNode, generateMessageID, generateProfilePicture, getUrlFromDirectPath } from '../Utils'
import { BinaryNode, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from '../WABinary'
import { makeGroupsSocket } from './groups'

// ENUM QueryIds DIHAPUS DARI SINI

export const makeNewsletterSocket = (config: SocketConfig) => {
	const suki = makeGroupsSocket(config) // 'sock' diubah menjadi 'suki'
	const { authState, signalRepository, query, generateMessageTag } = suki // referensi 'suki'

	const encoder = new TextEncoder()

	const newsletterQuery = async(jid: string, type: 'get' | 'set', content: BinaryNode[]) => (
		query({
			tag: 'iq',
			attrs: {
				id: generateMessageTag(),
				type,
				xmlns: 'newsletter',
				to: jid,
			},
			content
		})
	)

	const newsletterWMexQuery = async(jid: string | undefined, query_id: QueryIds, content?: object) => (
		query({
			tag: 'iq',
			attrs: {
				id: generateMessageTag(),
				type: 'get',
				xmlns: 'w:mex',
				to: S_WHATSAPP_NET,
			},
			content: [
				{
					tag: 'query',
					attrs: { query_id },
					content: encoder.encode(
						JSON.stringify({
							variables: {
								'newsletter_id': jid,
								...content
							}
						})
					)
				}
			]
		})
	)

	const parseFetchedUpdates = async(node: BinaryNode, type: 'messages' | 'updates') => {
		let child 
		
		if(type === 'messages') child = getBinaryNodeChild(node, 'messages')
		else {
			const parent = getBinaryNodeChild(node, 'message_updates')
			child = getBinaryNodeChild(parent, 'messages')
		}

		return await Promise.all(getAllBinaryNodeChildren(child!).map(async messageNode => {
			messageNode.attrs.from = child?.attrs.jid as string

			const views = parseInt(getBinaryNodeChild(messageNode, 'views_count')?.attrs?.count || '0')
			const reactionNode = getBinaryNodeChild(messageNode, 'reactions')
			const reactions = getBinaryNodeChildren(reactionNode, 'reaction')
				.map(({ attrs }) => ({ count: +attrs.count, code: attrs.code } as NewsletterReaction))


			const data: NewsletterFetchedUpdate = {
				'server_id': messageNode.attrs.server_id,
				views,
				reactions
			}

			if(type === 'messages') {
				const { fullMessage: message, decrypt } = await decryptMessageNode(
					messageNode,
					authState.creds.me!.id,
					authState.creds.me!.lid || '',
					signalRepository,
					config.logger
				)

				await decrypt()

				data.message = message
			}

			return data
		}))
	}

	// Fungsi ini didefinisikan di dalam agar dapat mengakses 'newsletterWMexQuery'
	const newsletterMetadata = async(type: 'invite' | 'jid', key: string, role?: NewsletterViewRole) => {
		const result = await newsletterWMexQuery(undefined, QueryIds.METADATA, {
			input: {
				key,
				type: type.toUpperCase(),
				view_role: role || 'GUEST'
			},
			fetch_viewer_metadata: true,
			fetch_full_image: true,
			fetch_creation_time: true
		})

		return extractNewsletterMetadata(result)
	}

	return {
		...suki, // referensi 'suki'
		newsletterQuery,
		newsletterWMexQuery,
		subscribeNewsletterUpdates: async(jid: string) => {
			const result = await newsletterQuery(jid, 'set', [{ tag: 'live_updates', attrs: {}, content: [] }])

			return getBinaryNodeChild(result, 'live_updates')?.attrs as { duration: string }
		},

		newsletterReactionMode: async(jid: string, mode: NewsletterReactionMode) => {
			await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
				updates: { settings: { reaction_codes: { value: mode }}}
			})
		},

		newsletterUpdateDescription: async(jid: string, description?: string) => {
			await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
				updates: { description: description || '', settings: null }
			})
		},

		newsletterUpdateName: async(jid: string, name: string) => {
			await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
				updates: { name, settings: null }
			})
		},

		newsletterUpdatePicture: async(jid: string, content: WAMediaUpload) => {
			const { img } = await generateProfilePicture(content)

			await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
				updates: { picture: img.toString('base64'), settings: null }
			})
		},

		newsletterRemovePicture: async(jid: string) => {
			await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
				updates: { picture: '', settings: null }
			})
		},

		newsletterUnfollow: async(jid: string) => {
			await newsletterWMexQuery(jid, QueryIds.UNFOLLOW)
		},

		newsletterFollow: async(jid: string) => {
			await newsletterWMexQuery(jid, QueryIds.FOLLOW)
		},

		newsletterUnmute: async(jid: string) => {
			await newsletterWMexQuery(jid, QueryIds.UNMUTE)
		},

		newsletterMute: async(jid: string) => {
			await newsletterWMexQuery(jid, QueryIds.MUTE)
		},

		// Fungsi baru ditambahkan
		newsletterAction: async (jid: string, type: 'UNFOLLOW' | 'FOLLOW' | 'UNMUTE' | 'MUTE' | 'DELETE') => {
			// Menggunakan enum QueryIds lokal
			await newsletterWMexQuery(jid, QueryIds[type])
		},

		newsletterCreate: async(name: string, description?: string, picture?: WAMediaUpload) => {
			await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					xmlns: 'tos',
					id: generateMessageTag(),
					type: 'set'
				},
				content: [
					{
						tag: 'notice',
						attrs: {
							id: '20601218',
							stage: '5'
						},
						content: []
					}
				]
			})
			const result = await newsletterWMexQuery(undefined, QueryIds.CREATE, {
				input: {
					name,
					description: description || null,
					picture: picture ? (await generateProfilePicture(picture)).img.toString('base64') : null,
					// Diperbarui
					settings: {
						reaction_codes: {
							value: 'ALL'
						}
					}
				}
			})

			return extractNewsletterMetadata(result, true)
		},

		newsletterMetadata, // Mengekspos fungsi yang didefinisikan di atas

		newsletterAdminCount: async(jid: string) => {
			const result = await newsletterWMexQuery(jid, QueryIds.ADMIN_COUNT)

			const buff = getBinaryNodeChild(result, 'result')?.content?.toString()
			
			return JSON.parse(buff!).data[XWAPaths.ADMIN_COUNT].admin_count as number
		},

		// Fungsi baru ditambahkan
		newsletterFetchAllParticipating: async () => {
			const data: { [key: string]: NewsletterMetadata } = {}
		
			const result = await newsletterWMexQuery(undefined, QueryIds.SUBSCRIBED) 
			const child = JSON.parse(getBinaryNodeChild(result, 'result')?.content?.toString()!)
			const newsletters = child.data[XWAPaths.SUBSCRIBED]
		
			for (const i of newsletters) {
				if (i.id == null) continue
			
				// Menggunakan fungsi newsletterMetadata internal
				// DIPERBAIKI: 'JID' diubah menjadi 'jid' (lowercase)
				const metadata = await newsletterMetadata('jid', i.id) 
				if (metadata.id !== null) data[metadata.id] = metadata
			}
			
			return data
		},

		/**user is Lid, not Jid */
		newsletterChangeOwner: async(jid: string, user: string) => {
			await newsletterWMexQuery(jid, QueryIds.CHANGE_OWNER, {
				user_id: user
			})
		},

		/**user is Lid, not Jid */
		newsletterDemote: async(jid: string, user: string) => {
			await newsletterWMexQuery(jid, QueryIds.DEMOTE, {
				user_id: user
			})
		},

		newsletterDelete: async(jid: string) => {
			await newsletterWMexQuery(jid, QueryIds.DELETE)
		},

		/**if code wasn't passed, the reaction will be removed (if is reacted) */
		newsletterReactMessage: async(jid: string, server_id: string, code?: string) => {
			await query({
				tag: 'message',
				attrs: { to: jid, ...(!code ? { edit: '7' } : {}), type: 'reaction', server_id, id: generateMessageID()},
				content: [{
					tag: 'reaction',
					attrs: code ? {code} : {}
				}]
			})
		},

		newsletterFetchMessages: async(type: 'invite' | 'jid', key: string, count: number, after?: number) => {
			const afterStr: any = after?.toString()
			const result = await newsletterQuery(S_WHATSAPP_NET, 'get', [
				{
					tag: 'messages',
					attrs: { type, ...(type === 'invite' ? { key } : { jid: key }), count: count.toString(), after: afterStr || '100' }
				}
			])

			return await parseFetchedUpdates(result, 'messages')
		},

		newsletterFetchUpdates: async(jid: string, count: number, after?: number, since?: number) => {
			const result = await newsletterQuery(jid, 'get', [
				{
					tag: 'message_updates',
					attrs: { count: count.toString(), after: after?.toString() || '100', since: since?.toString() || '0' }
				}
			])

			return await parseFetchedUpdates(result, 'updates')
		}
	}
}

// Diperbarui agar lebih aman (robust) dengan optional chaining dan getUrlFromDirectPath
export const extractNewsletterMetadata = (node: BinaryNode, isCreate?: boolean) => {
	const result = getBinaryNodeChild(node, 'result')?.content?.toString()
	const metadataPath = JSON.parse(result!).data[isCreate ? XWAPaths.CREATE : XWAPaths.NEWSLETTER]

	const metadata: NewsletterMetadata = {
		id: metadataPath?.id,
		state: metadataPath?.state?.type,
		creation_time: +metadataPath?.thread_metadata?.creation_time,
		name: metadataPath?.thread_metadata?.name?.text,
		nameTime: +metadataPath?.thread_metadata?.name?.update_time,
		description: metadataPath?.thread_metadata?.description?.text,
		descriptionTime: +metadataPath?.thread_metadata?.description?.update_time,
		invite: metadataPath?.thread_metadata?.invite,
		handle: metadataPath?.thread_metadata?.handle,
		picture: getUrlFromDirectPath(metadataPath?.thread_metadata?.picture?.direct_path || ''),
		preview: getUrlFromDirectPath(metadataPath?.thread_metadata?.preview?.direct_path || ''),
		reaction_codes: metadataPath?.thread_metadata?.settings?.reaction_codes?.value,
		subscribers: +metadataPath?.thread_metadata?.subscribers_count,
		verification: metadataPath?.thread_metadata?.verification,
		viewer_metadata: metadataPath?.viewer_metadata
	}

	return metadata
}
