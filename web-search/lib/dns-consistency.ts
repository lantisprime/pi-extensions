export function chooseDnsConsistencyAddresses(systemAddresses: string[], secureDnsAddresses: string[]) {
	const overlap = systemAddresses.filter((address) => secureDnsAddresses.includes(address));
	return overlap.length > 0 ? overlap : systemAddresses;
}
