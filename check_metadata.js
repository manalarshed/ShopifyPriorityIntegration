const fs = require('fs');

const metadata = fs.readFileSync('metadata.xml', 'utf8');

// Find PART entity specifically
const partEntityMatch = metadata.match(/EntityType Name="PART"[^>]*>([\s\S]*?)<\/EntityType>/);

if (partEntityMatch) {
  const partEntity = partEntityMatch[0];
  const navProps = [...partEntity.matchAll(/NavigationProperty Name="([^"]+)"/g)];
  console.log('✅ PART NavigationProperties (subforms):');
  navProps.forEach(m => console.log(' -', m[1]));
} else {
  console.log('❌ PART entity not found');
}
