export default {
	fetch(request: Request): Response {
		if (request.method !== 'GET') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		return new Response('Hello World!');
	},
} satisfies ExportedHandler;
